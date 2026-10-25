# 扫描 PPT 文件夹并入库（解析、缩略图、归类）

import os
import shutil
import logging

from logger import get_logger

_log = get_logger(__name__)

PPT_EXTENSIONS = {'.pptx', '.ppt'}

# 扫目录时一律跳过的目录名（. 和 _ 开头的另外统一跳）
SKIP_DIR_NAMES = {
    'node_modules', '__pycache__', '$RECYCLE.BIN', 'System Volume Information',
    'Thumbs.db', '.Trash', '.Spotlight-V100', '.fseventsd', '.TemporaryItems',
    '.DocumentRevisions-V100', '.git', '.svn', '.hg', '.venv', 'venv',
}
# 办公软件的临时锁文件 / 云盘占位文件
SKIP_FILE_PREFIXES = ('~$', '.~')
SKIP_FILE_SUFFIXES = ('.icloud',)


def _skip_dir(name):
    return name.startswith('.') or name.startswith('_') or name in SKIP_DIR_NAMES


def _skip_reason(name):
    """返回跳过原因；None 表示不是要跳过的文件。"""
    if name.startswith(SKIP_FILE_PREFIXES):
        return '临时文件'
    if name.lower().endswith(SKIP_FILE_SUFFIXES):
        return '云盘占位文件'
    return None


def discover_root(root):
    """只读地走一遍目录，把候选文件和跳过原因列出来（不解析、不渲染缩略图）。

    返回 {'root', 'exists', 'files': [{path, rel, name, size, mtime}],
          'skipped': {原因: {count, examples}}}
    """
    info = {'root': root, 'exists': os.path.isdir(root), 'files': [], 'skipped': {}}

    def _skip(reason, path):
        slot = info['skipped'].setdefault(reason, {'count': 0, 'examples': []})
        slot['count'] += 1
        if len(slot['examples']) < 5:
            slot['examples'].append(os.path.basename(path))

    if not info['exists']:
        return info

    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not _skip_dir(d))
        for name in files:
            full = os.path.join(dirpath, name)
            reason = _skip_reason(name)
            if reason:
                _skip(reason, full)
                continue
            if os.path.splitext(name)[1].lower() not in PPT_EXTENSIONS:
                continue
            try:
                st = os.stat(full)
            except OSError:
                _skip('读不到（权限或被占用）', full)
                continue
            if st.st_size == 0:
                _skip('0 字节（云盘占位或空文件）', full)
                continue
            info['files'].append({
                'path': full,
                'rel': os.path.relpath(dirpath, root),
                'name': name,
                'size': st.st_size,
                'mtime': st.st_mtime,
            })
    return info


def classify_candidates(db, root_infos, newest_only=False):
    """把发现结果对照数据库分成 new / changed / known / moved 四类。

    moved：文件名 + 大小都对得上、而原路径已经不在的旧记录 —— 认领它，只改路径，
    不重复入库（否则把文件从「投标」挪到「2026投标」会在库里出现两份）。

    newest_only：同名（不区分大小写）只留修改时间最新的一份，其余记为「同名旧版本」。
    返回 (entries, dropped) —— dropped 是被同名规则挡下的那些。
    """
    all_files = db.get_all_files()
    known_by_path = {f['file_path']: f for f in all_files}
    by_sig = {}
    for f in all_files:
        if f['file_size'] and not os.path.exists(f['file_path']):
            key = (f['file_name'].lower(), f['file_size'])
            by_sig.setdefault(key, []).append(f)

    entries = []
    seen_paths = set()
    for info in root_infos:
        for item in info['files']:
            real = os.path.realpath(item['path'])
            if real in seen_paths:
                # 同一个文件被父目录与子目录两个位置同时发现：只留第一次
                continue
            seen_paths.add(real)
            entry = dict(item)
            entry['root'] = info['root']
            entry['bytes'] = item['size']
            rec = known_by_path.get(item['path'])
            if rec:
                unchanged = (rec['file_size'] == item['size']
                             and abs((rec['modified_time'] or 0) - item['mtime']) <= 1
                             and rec['processed'])
                entry['status'] = 'known' if unchanged else 'changed'
                entry['file_id'] = rec['id']
                entry['slides'] = rec['total_slides']
            else:
                key = (item['name'].lower(), item['size'])
                candidates = by_sig.get(key)
                if candidates:
                    old = candidates.pop(0)
                    if not candidates:
                        by_sig.pop(key, None)
                    same_time = abs((old['modified_time'] or 0) - item['mtime']) <= 1
                    entry['status'] = 'moved' if same_time else 'moved_changed'
                    entry['file_id'] = old['id']
                    entry['moved_from'] = old['file_path']
                    entry['slides'] = old['total_slides']
                else:
                    entry['status'] = 'new'
            entries.append(entry)

    dropped = []
    if newest_only:
        newest = {}
        for e in entries:
            key = e['name'].lower()
            cur = newest.get(key)
            if cur is None or e['mtime'] > cur['mtime']:
                newest[key] = e
        keep = {id(v) for v in newest.values()}
        dropped = [e for e in entries if id(e) not in keep]
        entries = [e for e in entries if id(e) in keep]
    return entries, dropped


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
                        progress_callback=None, cancel=None, page_cb=None,
                        classify=True):
    """Parse → thumbnails → classify → store. Returns (slide_count, error_message).

    cancel: 可选回调，返回 True 表示用户点了取消 —— 立刻停手并抛 Interrupted。
    调用方应把本函数包在 db.transaction() 里，异常时整体回滚，这个文件不留半截数据。
    page_cb(done, total): 页级进度回调（解析完先报 0/总页数，之后每渲染一页报一次）。
    classify: False 时只入库不归类（右键打开文件时由用户先决定要不要归类）。
    """
    from ppt_parser import parse_file, PartialParseError
    from thumbnail import generate_thumbnails
    from interrupt import Interrupted

    file_name = os.path.basename(file_path)

    def _check():
        if cancel and cancel():
            raise Interrupted()

    _check()
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

    _check()
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

    # 缩略图先渲染到 *.part 临时目录，全部成功后才整目录换上去：
    # 中途取消不会把旧版本图覆盖掉一半，也不会留下半套图。
    thumb_dir = os.path.join(thumbnail_base_dir, str(file_id))
    work_dir = thumb_dir + '.part'
    shutil.rmtree(work_dir, ignore_errors=True)
    # 解析完就知道这个文件有多少页，先告诉界面（转换期间也有页数可显示）
    if page_cb:
        try: page_cb(0, len(slides_data))
        except Exception: pass
    try:
        work_paths = generate_thumbnails(file_path, work_dir,
                                         slides_data=slides_data, cancel=cancel,
                                         page_cb=page_cb) or []
    except Interrupted:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    except Exception as e:
        _log.error("Thumbnail generation failed for %s: %s", file_path, e, exc_info=True)
        work_paths = []
        shutil.rmtree(work_dir, ignore_errors=True)

    thumb_paths = []
    if work_paths:
        try:
            os.makedirs(thumb_dir, exist_ok=True)
            keep = set()
            for p in work_paths:
                if not p:
                    continue
                dst = os.path.join(thumb_dir, os.path.basename(p))
                os.replace(p, dst)
                keep.add(os.path.basename(p))
                thumb_paths.append(dst)
            # Remove stale thumbnails left over from a previous version of this file
            # (e.g. re-scan after the file shrank).
            for fn in os.listdir(thumb_dir):
                if fn.lower().endswith('.png') and fn not in keep:
                    try:
                        os.remove(os.path.join(thumb_dir, fn))
                    except OSError:
                        pass
        except OSError as e:
            _log.warning("换入缩略图失败 %s: %s", file_path, e)
            if not thumb_paths:
                thumb_paths = [p for p in work_paths if p]
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    if progress_callback:
        progress_callback(f"正在归类: {file_name}")

    classify_mode = db.get_setting('classify_mode', 'hybrid')

    for sd in slides_data:
        _check()   # 归类的过程中也能停：一页一秒量级，够快
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

        if classify:
            try:
                _apply_classification(db, classifier, slide_id, sd, file_path, classify_mode)
            except Exception as e:
                _log.warning("Classification failed for slide %s:%d: %s",
                             file_path, sn, e)

    _check()
    db.mark_file_processed(file_id)
    _log.info("Processed %s: %d slides", file_name, len(slides_data))
    return len(slides_data), parse_warning
