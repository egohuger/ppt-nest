# 扫描 PPT 文件夹并入库（解析、缩略图、归类）

import os
import logging

from logger import get_logger

_log = get_logger(__name__)

PPT_EXTENSIONS = {'.pptx', '.ppt'}


def find_ppt_files(folder):
    """Recursively find PPT/PPTX files, skipping internal directories."""
    ppt_files = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith('_')]
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in PPT_EXTENSIONS and not f.startswith('~$'):
                ppt_files.append(os.path.join(root, f))
    return sorted(ppt_files)


def check_needs_processing(file_path, db):
    try:
        stat = os.stat(file_path)
    except OSError:
        return False
    existing = db.get_file_by_path(file_path)
    if not existing:
        return True
    if existing['modified_time'] != stat.st_mtime:
        return True
    if existing['file_size'] != stat.st_size:
        return True
    if not existing['processed']:
        return True
    return False


def check_deleted_files(folder, db):
    deleted = []
    for f in db.get_all_files():
        if not os.path.exists(f['file_path']):
            deleted.append(f)
    return deleted


def _apply_classification(db, classifier, slide_id, slide_data, file_path, classify_mode):
    """Apply classification to a single slide based on classify_mode.
    Modes: keyword, hybrid, llm. Manual mode skips entirely."""
    if classify_mode == 'manual':
        return

    from llm_classifier import classify_slide_with_llm, _build_category_catalog

    # ── LLM-only mode: try LLM first, fall back to keyword on failure ──
    if classify_mode == 'llm':
        api_key = (db.get_setting('api_key', '') or '').strip()
        if api_key:
            try:
                catalog = _build_category_catalog(db)
                slide_row = {
                    'title': slide_data['title'],
                    'text_content': slide_data['text_content'],
                }
                provider = db.get_setting('llm_provider', 'zhipu')
                model = db.get_setting('model_name', '') or None
                base_url = db.get_setting('api_base_url', '') or None
                cid, conf = classify_slide_with_llm(
                    db, slide_row, catalog,
                    api_key, provider=provider, model=model, base_url=base_url)
                if cid:
                    db.set_slide_category(slide_id, cid, conf, 'llm')
                    return  # LLM succeeded — don't fall through to keyword
            except Exception:
                _log.warning("LLM classify failed, falling back to keyword", exc_info=True)
        # LLM unavailable or failed → fall through to keyword below

    # ── Keyword classification (used by: keyword mode, hybrid mode, LLM fallback) ──
    cat_id, conf = classifier.classify_slide(
        slide_data['text_content'],
        title=slide_data.get('title', ''),
        file_path=file_path,
    )
    if cat_id is not None:
        db.set_slide_category(slide_id, cat_id, conf, source='auto')
    elif classify_mode == 'hybrid':
        # Keyword below threshold → try LLM as supplement
        api_key = (db.get_setting('api_key', '') or '').strip()
        if api_key:
            try:
                catalog = _build_category_catalog(db)
                slide_row = {
                    'title': slide_data['title'],
                    'text_content': slide_data['text_content'],
                }
                provider = db.get_setting('llm_provider', 'zhipu')
                model = db.get_setting('model_name', '') or None
                base_url = db.get_setting('api_base_url', '') or None
                cid, conf = classify_slide_with_llm(
                    db, slide_row, catalog,
                    api_key, provider=provider, model=model, base_url=base_url)
                if cid:
                    db.set_slide_category(slide_id, cid, conf, 'llm')
            except Exception:
                pass


def process_single_file(file_path, db, classifier, thumbnail_base_dir,
                        progress_callback=None):
    """Parse → thumbnails → classify → store. Returns (slide_count, error_message)."""
    from ppt_parser import parse_file, PartialParseError
    from thumbnail import generate_thumbnails

    file_name = os.path.basename(file_path)

    try:
        stat = os.stat(file_path)
    except OSError as e:
        _log.error("Cannot stat file %s: %s", file_path, e)
        return 0, f"无法读取文件: {e}"

    if progress_callback:
        progress_callback(f"正在解析: {file_name}")

    parse_warning = None
    try:
        slides_data = parse_file(file_path)
    except PartialParseError as e:
        # 部分解析：保留已解析的页面，但标记为不完整并报告给用户
        slides_data = e.slides_data
        parse_warning = str(e)
        _log.warning("Partial parse for %s: %s", file_path, e)
    except Exception as e:
        _log.error("Parse failed for %s: %s", file_path, e, exc_info=True)
        return 0, f"解析失败: {e}"

    if not slides_data:
        _log.warning("No slides found in %s", file_path)
        return 0, "文件中没有可解析的页面"

    db.add_file(
        file_path=file_path,
        file_name=file_name,
        file_size=stat.st_size,
        modified_time=stat.st_mtime,
        total_slides=len(slides_data),
    )
    file_record = db.get_file_by_path(file_path)
    file_id = file_record['id']

    if progress_callback:
        progress_callback(f"正在生成缩略图: {file_name}")

    try:
        thumb_dir = os.path.join(thumbnail_base_dir, str(file_id))
        thumb_paths = generate_thumbnails(file_path, thumb_dir, slides_data=slides_data)
    except Exception as e:
        _log.error("Thumbnail generation failed for %s: %s", file_path, e, exc_info=True)
        thumb_paths = []

    # Remove stale thumbnails left over from a previous version of this file
    # (e.g. re-scan after the file shrank). Only when generation succeeded,
    # otherwise we'd wipe the existing (still valid) thumbnails.
    if thumb_paths:
        try:
            expected = {os.path.basename(p) for p in thumb_paths if p}
            for fn in os.listdir(thumb_dir):
                if fn.lower().endswith('.png') and fn not in expected:
                    try:
                        os.remove(os.path.join(thumb_dir, fn))
                    except OSError:
                        pass
        except OSError:
            pass

    if progress_callback:
        progress_callback(f"正在归类: {file_name}")

    classify_mode = db.get_setting('classify_mode', 'hybrid')

    for sd in slides_data:
        sn = sd['slide_number']
        tp = thumb_paths[sn - 1] if sn <= len(thumb_paths) else ''
        if tp:
            tp = os.path.relpath(tp, thumbnail_base_dir).replace('\\', '/')

        slide_id = db.add_slide(
            file_id=file_id,
            slide_number=sn,
            title=sd['title'],
            text_content=sd['text_content'],
            content_hash=sd['content_hash'],
            thumbnail_path=tp,
        )

        try:
            _apply_classification(db, classifier, slide_id, sd, file_path, classify_mode)
        except Exception as e:
            _log.warning("Classification failed for slide %s:%d: %s",
                         file_path, sn, e)

    db.mark_file_processed(file_id)
    _log.info("Processed %s: %d slides", file_name, len(slides_data))
    return len(slides_data), parse_warning
