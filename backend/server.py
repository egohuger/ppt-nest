"""
PPT Nest Backend - FastAPI Server
提供 REST API 给 Electron 前端调用
"""

import os
import sys
import json
import time
import base64
import shutil
import subprocess
import threading

# 确保可以导入同级模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

from database import Database
from scanner import find_ppt_files, check_needs_processing, check_deleted_files, process_single_file, _apply_classification
from classifier import KeywordClassifier, DEFAULT_NEGATIVE_RULES
from dedup import run_dedup
from config import get_data_dir, set_data_dir, get_db_path, get_thumbnail_dir, get_default_ppt_folder, resolve_ppt_folder
from llm_classifier import batch_llm_classify

app = FastAPI(title="PPT Nest API", version="2.1")

# CORS - restrict to local origins only (Electron renderer + local dev).
# Regex covers any local port (Electron picks a free port at startup),
# file:// pages and origin-less requests.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'^(https?://(127\.0\.0\.1|localhost)(:\d+)?|file://.*|null)$',
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ─── Database singleton ───
_db = None

def get_db():
    global _db
    if _db is None:
        os.makedirs(get_data_dir(), exist_ok=True)
        _db = Database(get_db_path())
        _db.init_default_categories()
    return _db

def get_classifier():
    return KeywordClassifier(get_db())

# ─── Pydantic models ───
class CategoryUpdate(BaseModel):
    category_id: int = 0  # 0 = remove category

class CategoryCreate(BaseModel):
    name: str
    parent_id: int | None = None
    keywords: list[str] = []

class CategoryEdit(BaseModel):
    name: str | None = None
    keywords: list[str] | None = None

class CollectionCreate(BaseModel):
    name: str

class CollectionRename(BaseModel):
    name: str

class CollectionAddSlide(BaseModel):
    slide_id: int

class SettingsUpdate(BaseModel):
    data_dir: str | None = None
    ppt_folder: str | None = None
    classify_mode: str | None = None
    classify_min_confidence: float | None = None
    dedup_threshold: float | None = None
    api_key: str | None = None
    api_base_url: str | None = None
    model_name: str | None = None
    llm_provider: str | None = None

class CategoryImportPayload(BaseModel):
    categories: list[dict] = []

class ScanProcessRequest(BaseModel):
    files: list[str] = []

# ─── Helpers ───
def _slide_to_dict(slide, db=None, cat_cache=None):
    """Convert sqlite3.Row to dict with resolved fields.
    cat_cache: optional {slide_id: category_dict} to avoid N+1 queries."""
    d = dict(slide)
    if db or cat_cache is not None:
        if cat_cache is not None and slide['id'] in cat_cache:
            sc = cat_cache[slide['id']]
        elif db:
            sc = db.get_slide_category(slide['id'])
        else:
            sc = None
        if sc:
            d['category_name'] = sc['category_name']
            d['category_id'] = sc['category_id']
            d['category_source'] = sc['source']
        else:
            d['category_name'] = None
            d['category_id'] = 0
            d['category_source'] = None
    return d


def _batch_collection_lookup(db, slides):
    """Resolve collection IDs for a batch of slides in one query (fixes N+1).
    Returns dict: slide_id → [collection_id, ...].
    Batches queries to stay under SQLite's 999-parameter limit."""
    if not slides:
        return {}
    ids = [s['id'] for s in slides]
    result = {}
    batch_size = 900
    for i in range(0, len(ids), batch_size):
        batch = ids[i:i + batch_size]
        placeholders = ','.join('?' * len(batch))
        rows = db.conn.execute(
            f'SELECT slide_id, collection_id FROM collection_items WHERE slide_id IN ({placeholders})',
            batch
        ).fetchall()
        for r in rows:
            result.setdefault(r['slide_id'], []).append(r['collection_id'])
    return result


def _batch_category_lookup(db, slides):
    """Resolve categories for a batch of slides in one query.
    Returns dict: slide_id → {category_name, category_id, source}.
    Batches queries to stay under SQLite's 999-parameter limit."""
    if not slides:
        return {}
    ids = [s['id'] for s in slides]
    result = {}
    batch_size = 900
    for i in range(0, len(ids), batch_size):
        batch = ids[i:i + batch_size]
        placeholders = ','.join('?' * len(batch))
        rows = db.conn.execute(
            f'''SELECT sc.slide_id, sc.category_id, sc.source,
                       c.name AS category_name
                FROM slide_categories sc
                JOIN categories c ON sc.category_id = c.id
                WHERE sc.slide_id IN ({placeholders})''',
            batch
        ).fetchall()
        for r in rows:
            result[r['slide_id']] = {
                'category_id': r['category_id'],
                'category_name': r['category_name'],
                'source': r['source'],
            }
    return result


def _resolve_thumb_url(thumb_path):
    """Convert a thumbnail path to a URL the frontend can fetch."""
    if not thumb_path:
        return None
    thumb_dir = get_thumbnail_dir()
    if os.path.isabs(thumb_path):
        # Extract relative part
        norm = thumb_path.replace('\\', '/')
        marker = '/thumbnails/'
        idx = norm.find(marker)
        if idx >= 0:
            rel = norm[idx + len(marker):]
        else:
            rel = os.path.basename(thumb_path)
    else:
        rel = thumb_path.replace('\\', '/')
    # URL-encode the path (keep slashes)
    return f"/api/thumbnail/{rel}"


def _paginate_slides(slides, page, page_size):
    """Slice a pre-fetched list into a page result."""
    total = len(slides)
    start = (page - 1) * page_size
    page_items = slides[start:start + page_size]
    return total, page_items


# ─── Stats ───
@app.get("/api/stats")
def get_stats():
    db = get_db()
    stats = db.get_stats()
    return stats


# ─── Files ───
@app.get("/api/files")
def list_files():
    db = get_db()
    files = db.get_files_with_counts()
    return [dict(f) for f in files]


# ─── Slides ───
@app.get("/api/slides")
def list_slides(
    category_id: int | None = None,
    include_children: bool = False,
    include_hidden: bool = False,
    collection_id: int | None = None,
    file_id: int | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
):
    db = get_db()

    # Use SQL-level filtering instead of loading everything into memory
    slides = db.get_slides_filtered(
        category_id=category_id,
        include_children=include_children,
        collection_id=collection_id,
        file_id=file_id,
        q=q,
        include_hidden=include_hidden,
    )

    total = len(slides)
    start = (page - 1) * page_size
    page_slides = slides[start:start + page_size]

    # Batch category + collection lookup (fixes N+1)
    cat_cache = _batch_category_lookup(db, page_slides)
    col_cache = _batch_collection_lookup(db, page_slides)

    items = []
    for s in page_slides:
        d = _slide_to_dict(s, cat_cache=cat_cache)
        d['thumbnail_url'] = _resolve_thumb_url(d.get('thumbnail_path', ''))
        # Add collection IDs for this slide
        d['collection_ids'] = col_cache.get(s['id'], [])
        items.append(d)

    return {"total": total, "page": page, "page_size": page_size, "items": items}


# ─── Single slide ───
@app.get("/api/slides/{slide_id}")
def get_slide(slide_id: int):
    db = get_db()
    slide = db.conn.execute("SELECT * FROM slides WHERE id = ?", (slide_id,)).fetchone()
    if not slide:
        raise HTTPException(status_code=404, detail="Slide not found")
    d = _slide_to_dict(slide, db)
    d['thumbnail_url'] = _resolve_thumb_url(d.get('thumbnail_path', ''))
    d['collection_ids'] = db.get_slide_collections(slide_id)
    return d


# ─── Update slide category ───
@app.put("/api/slides/{slide_id}/category")
def update_slide_category(slide_id: int, body: CategoryUpdate):
    db = get_db()
    if body.category_id == 0:
        db.remove_slide_category(slide_id)
    else:
        db.set_slide_category(slide_id, body.category_id, 1.0, 'manual')
    return {"ok": True}


# ─── Delete slide completely ───
@app.delete("/api/slides/{slide_id}")
def delete_slide(slide_id: int):
    db = get_db()
    success, msg = db.delete_slide_completely(slide_id)
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


# ─── Search ───
@app.get("/api/search")
def search(
    q: str = "",
    include_hidden: bool = False,
    page: int = 1,
    page_size: int = 20,
):
    db = get_db()
    inc = include_hidden

    if q:
        results = db.search_slides(q, include_hidden=inc)
    else:
        results = db.get_all_slides(include_hidden=inc)

    total = len(results)
    start = (page - 1) * page_size
    page_results = results[start:start + page_size]

    cat_cache = _batch_category_lookup(db, page_results)
    col_cache = _batch_collection_lookup(db, page_results)

    items = []
    for s in page_results:
        d = _slide_to_dict(s, cat_cache=cat_cache)
        d['thumbnail_url'] = _resolve_thumb_url(d.get('thumbnail_path', ''))
        d['collection_ids'] = col_cache.get(s['id'], [])
        items.append(d)

    return {"total": total, "page": page, "page_size": page_size, "items": items}


# ─── Categories ───
@app.get("/api/categories")
def list_categories():
    db = get_db()
    return db.get_category_tree()

@app.post("/api/categories")
def create_category(body: CategoryCreate):
    db = get_db()
    cid = db.add_category(body.name, parent_id=body.parent_id, keywords=body.keywords)
    return {"ok": True, "id": cid}

@app.put("/api/categories/{cat_id}")
def update_category(cat_id: int, body: CategoryEdit):
    db = get_db()
    db.update_category(cat_id, name=body.name, keywords=body.keywords)
    return {"ok": True}

@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: int):
    db = get_db()
    db.delete_category(cat_id)
    return {"ok": True}

@app.post("/api/categories/import")
def import_categories(body: CategoryImportPayload):
    """Import a full category tree. Replaces all existing categories."""
    db = get_db()
    db.reset_all_categories()
    imported = db.import_category_tree(body.categories)
    get_classifier().reload()
    return {"ok": True, "imported": imported}

@app.get("/api/categories/export")
def export_categories():
    """Export current category tree as JSON (for backup / editing)."""
    db = get_db()
    return db.export_category_tree()

@app.post("/api/categories/reset")
def reset_categories():
    db = get_db()
    db.reset_all_categories()
    get_classifier().reload()
    return {"ok": True}


# ─── Collections ───
@app.get("/api/collections")
def list_collections():
    db = get_db()
    cols = [dict(c) for c in db.get_collections()]
    return cols

@app.post("/api/collections")
def create_collection(body: CollectionCreate):
    db = get_db()
    cid = db.create_collection(body.name)
    return {"ok": True, "id": cid, "name": body.name}

@app.put("/api/collections/{col_id}")
def rename_collection(col_id: int, body: CollectionRename):
    db = get_db()
    db.rename_collection(col_id, body.name)
    return {"ok": True}

@app.delete("/api/collections/{col_id}")
def delete_collection(col_id: int):
    db = get_db()
    db.delete_collection(col_id)
    return {"ok": True}

@app.post("/api/collections/{col_id}/slides")
def add_to_collection(col_id: int, body: CollectionAddSlide):
    db = get_db()
    ok = db.add_slide_to_collection(col_id, body.slide_id)
    if not ok:
        raise HTTPException(status_code=400, detail="添加失败")
    return {"ok": True}

@app.delete("/api/collections/{col_id}/slides/{slide_id}")
def remove_from_collection(col_id: int, slide_id: int):
    db = get_db()
    db.remove_slide_from_collection(col_id, slide_id)
    return {"ok": True}


# ─── Scan ───

_scan_progress = {"running": False, "current": 0, "total": 0, "current_file": "", "done": False, "scan_id": 0}
_scan_lock = threading.Lock()
_reclassify_progress = {"running": False, "current": 0, "total": 0, "done": False}
_reclassify_lock = threading.Lock()
_dedup_lock = threading.Lock()
_dedup_process = None  # subprocess handle

def _dedup_progress_file():
    """Progress JSON path — resolved lazily so data-dir changes take effect."""
    return os.path.join(get_data_dir(), 'dedup_progress.json')

@app.get("/api/scan/progress")
def scan_progress():
    return _scan_progress

@app.get("/api/scan/check")
def scan_check():
    db = get_db()
    ppt_folder = resolve_ppt_folder(db)
    all_files = find_ppt_files(ppt_folder)
    new_files = [f for f in all_files if check_needs_processing(f, db)]
    deleted = check_deleted_files(ppt_folder, db)
    return {
        "ppt_folder": ppt_folder,
        "total_files": len(all_files),
        "new_files": [{"path": f, "name": os.path.basename(f)} for f in new_files],
        "deleted_files": [{"path": d['file_path'], "name": d['file_name']} for d in deleted],
        "processed_files": [{
            "id": f['id'],
            "name": f['file_name'],
            "slides": f['total_slides'],
            "processed": bool(f['processed'])
        } for f in db.get_all_files()],
        # scan-specific settings
        "classify_mode": db.get_setting('classify_mode', 'hybrid'),
        "classify_min_confidence": float(db.get_setting('classify_min_confidence', '0.22')),
    }

@app.post("/api/scan/process")
def scan_process():
    """Process all new PPT files found in the configured folder."""
    global _scan_progress
    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="扫描已在运行中")

    try:
        db = get_db()
        ppt_folder = resolve_ppt_folder(db)
        all_files = find_ppt_files(ppt_folder)
        new_files = [f for f in all_files if check_needs_processing(f, db)]

        if not new_files:
            return {"ok": True, "processed": 0, "errors": []}

        scan_id = int(time.time() * 1000)
        _scan_progress = {
            "running": True, "current": 0, "total": len(new_files),
            "current_file": "", "done": False, "scan_id": scan_id,
        }

        classifier = get_classifier()
        thumb_dir = get_thumbnail_dir()
        total_slides = 0
        errors = []

        for i, fp in enumerate(new_files):
            if _scan_progress.get("scan_id") != scan_id:
                break  # cancelled
            _scan_progress["current"] = i + 1
            _scan_progress["current_file"] = os.path.basename(fp)
            try:
                n, err = process_single_file(fp, db, classifier, thumb_dir)
                if err:
                    errors.append({"file": os.path.basename(fp), "error": err})
                else:
                    total_slides += n
            except Exception as e:
                errors.append({"file": os.path.basename(fp), "error": str(e)})

    finally:
        _scan_progress = {
            "running": False, "current": _scan_progress.get("current", 0),
            "total": _scan_progress.get("total", 0), "current_file": "", "done": True,
            "scan_id": _scan_progress.get("scan_id", 0),
        }
        _scan_lock.release()

    return {
        "ok": True,
        "processed": len(new_files) - len(errors),
        "total_slides": total_slides,
        "errors": errors,
    }

@app.post("/api/scan/cancel")
def scan_cancel():
    global _scan_progress
    _scan_progress["scan_id"] = 0
    return {"ok": True}

@app.put("/api/scan/settings")
def update_scan_settings(
    ppt_folder: str | None = None,
    classify_mode: str | None = None,
    classify_min_confidence: float | None = None,
):
    db = get_db()
    if ppt_folder is not None:
        if not os.path.isdir(ppt_folder):
            raise HTTPException(status_code=400, detail="文件夹路径不存在")
        db.set_setting('ppt_folder', ppt_folder)
    if classify_mode is not None:
        db.set_setting('classify_mode', classify_mode)
    if classify_min_confidence is not None:
        db.set_setting('classify_min_confidence', str(classify_min_confidence))
    return {"ok": True}

@app.post("/api/scan/cleanup")
def scan_cleanup():
    """Remove DB records for files that no longer exist on disk."""
    db = get_db()
    ppt_folder = resolve_ppt_folder(db)
    deleted = check_deleted_files(ppt_folder, db)
    for f in deleted:
        db.delete_file_by_path(f['file_path'])
    return {"ok": True, "cleaned": len(deleted)}

# ─── Dedup (subprocess-based, zero GIL contention) ───

def _read_dedup_progress():
    """Read progress JSON written by the worker subprocess."""
    try:
        with open(_dedup_progress_file(), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"running": False, "current": 0, "total": 100, "done": False}

@app.post("/api/dedup/run")
def dedup_run(incremental: bool = False):
    global _dedup_process
    if not _dedup_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="重复检测已在运行中")

    try:
        db = get_db()
        threshold = db.get_setting('dedup_threshold', '0.85')
        db_path = get_db_path()

        # Clear progress file
        with open(_dedup_progress_file(), 'w', encoding='utf-8') as f:
            json.dump({"running": True, "current": 0, "total": 100, "done": False}, f)

        # Spawn worker subprocess — runs in its own Python process, zero GIL impact
        if getattr(sys, 'frozen', False):
            # Bundled onefile exe: server.exe doubles as the dedup worker
            args = [sys.executable, '--dedup-worker', db_path, str(threshold)]
        else:
            worker_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dedup_worker.py')
            args = [sys.executable, worker_script, db_path, str(threshold)]
        if incremental:
            args.append('--incremental')

        _dedup_process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Background thread: release lock when worker exits
        proc_handle = _dedup_process
        def _monitor():
            global _dedup_process
            try:
                proc_handle.wait()
            except Exception:
                pass
            _dedup_process = None
            # If the worker died without writing a final progress state
            # (crash / killed), patch the file so the frontend stops polling.
            try:
                prog = _read_dedup_progress()
                if prog.get('running') and not prog.get('done'):
                    prog.update({
                        'running': False, 'done': True,
                        'error': '检测进程意外退出，请重试',
                    })
                    with open(_dedup_progress_file(), 'w', encoding='utf-8') as f:
                        json.dump(prog, f, ensure_ascii=False)
            except Exception:
                pass
            _dedup_lock.release()

        threading.Thread(target=_monitor, daemon=True).start()

    except Exception:
        _dedup_lock.release()
        raise

    return {"ok": True, "message": "重复检测已在后台启动"}


@app.get("/api/dedup/progress")
def dedup_progress():
    return _read_dedup_progress()

@app.get("/api/dedup/pending-count")
def dedup_pending_count():
    """Return count of slides not yet covered by dedup watermark (for incremental dedup preview)."""
    db = get_db()
    last_max_id = int(db.get_setting('dedup_last_max_slide_id', '0'))
    count = db.conn.execute(
        'SELECT COUNT(*) FROM slides WHERE id > ?', (last_max_id,)
    ).fetchone()[0]
    return {"count": count}

@app.get("/api/dedup/groups")
def dedup_groups(page: int = 1, page_size: int = 10):
    db = get_db()
    groups = db.get_duplicate_groups()
    total = len(groups)

    start = (page - 1) * page_size
    page_groups = groups[start:start + page_size]

    result = []
    for g in page_groups:
        members = [dict(m) for m in db.get_duplicate_members(g['id'])]
        member_list = []
        for m in members:
            member_list.append({
                'id': m['id'],
                'slide_id': m['slide_id'],
                'file_name': m.get('file_name', ''),
                'slide_number': m.get('slide_number', 0),
                'title': m.get('title', ''),
                'is_primary': bool(m.get('is_primary', False)),
                'is_hidden': bool(m.get('is_hidden', False)),
                'thumbnail_url': _resolve_thumb_url(m.get('thumbnail_path', '')),
            })
        result.append({
            'id': g['id'],
            'group_type': g['group_type'],
            'members': member_list,
        })

    return {"total": total, "page": page, "page_size": page_size, "groups": result}

@app.post("/api/dedup/groups/{group_id}/primary")
def dedup_set_primary(group_id: int, slide_id: int = Query(...)):
    db = get_db()
    db.set_primary_duplicate(group_id, slide_id)
    return {"ok": True}

@app.delete("/api/dedup/members/{member_id}")
def dedup_remove_member(member_id: int):
    """Soft-delete a duplicate member (source file unchanged)."""
    db = get_db()
    member = db.conn.execute(
        "SELECT slide_id FROM duplicate_members WHERE id = ?", (member_id,)
    ).fetchone()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    success, msg = db.delete_slide_softly(member['slide_id'])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}

@app.post("/api/dedup/unhide-all")
def dedup_unhide_all():
    db = get_db()
    n = db.unhide_all_duplicate_slides()
    return {"ok": True, "unhidden": n}

@app.post("/api/dedup/hide-all")
def dedup_hide_all():
    db = get_db()
    n = db.hide_all_non_primary_duplicates()
    return {"ok": True, "hidden": n}

@app.post("/api/dedup/unhide/{slide_id}")
def dedup_unhide(slide_id: int):
    db = get_db()
    db.unhide_duplicate_by_slide(slide_id)
    return {"ok": True}

@app.get("/api/dedup/hidden")
def dedup_hidden():
    db = get_db()
    hidden = db.get_hidden_duplicate_slides()
    return [dict(h) for h in hidden]

# ─── Settings ───
@app.get("/api/settings")
def get_settings():
    db = get_db()
    return {
        "data_dir": get_data_dir(),
        "db_path": get_db_path(),
        "thumbnail_dir": get_thumbnail_dir(),
        "ppt_folder": resolve_ppt_folder(db),
        "default_ppt_folder": get_default_ppt_folder(),
        "classify_mode": db.get_setting('classify_mode', 'hybrid'),
        "classify_min_confidence": float(db.get_setting('classify_min_confidence', '0.22')),
        "dedup_threshold": float(db.get_setting('dedup_threshold', '0.85')),
        "llm_provider": db.get_setting('llm_provider', 'zhipu'),
        "api_key": db.get_setting('api_key', ''),
        "api_base_url": db.get_setting('api_base_url', ''),
        "model_name": db.get_setting('model_name', ''),
        "classify_negative_rules": db.get_setting('classify_negative_rules', ''),
    }

@app.put("/api/settings")
def update_settings(body: SettingsUpdate):
    db = get_db()

    # Switching the data dir closes the live DB connection — a running
    # scan/reclassify/dedup still holds the old handle and would fail on
    # every subsequent write. Reject the switch until tasks finish.
    if body.data_dir is not None and (
            _scan_lock.locked() or _reclassify_lock.locked() or _dedup_lock.locked()):
        raise HTTPException(
            status_code=409,
            detail="有任务正在运行（扫描/分类/去重），请等待完成后再切换数据目录")

    updates = {
        'classify_mode': body.classify_mode,
        'classify_min_confidence': str(body.classify_min_confidence) if body.classify_min_confidence is not None else None,
        'dedup_threshold': str(body.dedup_threshold) if body.dedup_threshold is not None else None,
        'llm_provider': body.llm_provider,
        'api_key': body.api_key,
        'api_base_url': body.api_base_url,
        'model_name': body.model_name,
    }
    for key, val in updates.items():
        if val is not None:
            db.set_setting(key, val)

    if body.ppt_folder is not None:
        db.set_setting('ppt_folder', body.ppt_folder)

    if body.data_dir is not None:
        os.makedirs(body.data_dir, exist_ok=True)
        set_data_dir(body.data_dir)
        global _db
        if _db:
            _db.close()
            _db = None

    return {"ok": True}

# ─── LLM Classify ───
@app.post("/api/llm/classify")
def llm_classify():
    db = get_db()
    thr = float(db.get_setting('classify_min_confidence', '0.22'))
    targets = db.get_slides_for_llm_classify(min_confidence=thr)
    if not targets:
        return {"ok": True, "classified": 0, "message": "没有需要补充归类的页面"}
    ok, errors, error_msgs = batch_llm_classify(db, targets)
    return {"ok": True, "classified": ok, "errors": errors, "error_msgs": error_msgs}

@app.post("/api/llm/absorb-keywords")
def llm_absorb_keywords():
    db = get_db()
    n = db.absorb_manual_keywords()
    get_classifier().reload()
    return {"ok": True, "absorbed": n}

# ─── Reclassify all ───

@app.get("/api/reclassify/progress")
def reclassify_progress():
    return _reclassify_progress

@app.post("/api/reclassify")
def reclassify_all():
    global _reclassify_progress
    if not _reclassify_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="重新分类已在运行中")

    total = 0  # must survive exceptions — referenced in finally
    n = 0
    errors = 0
    try:
        db = get_db()
        clf = get_classifier()
        slides = db.get_all_slides()
        total = len(slides)
        classify_mode = db.get_setting('classify_mode', 'hybrid')

        _reclassify_progress = {"running": True, "current": 0, "total": total, "done": False}

        # Batch pre-fetch manual categories to avoid N+1 per slide
        manual_ids = set()
        slide_cat_rows = db.conn.execute(
            "SELECT slide_id, source FROM slide_categories WHERE source = 'manual'"
        ).fetchall()
        for r in slide_cat_rows:
            manual_ids.add(r['slide_id'])

        for i, s in enumerate(slides):
            _reclassify_progress["current"] = i + 1
            if s['id'] in manual_ids:
                continue
            slide_data = {'title': s['title'] or '', 'text_content': s['text_content'] or ''}
            try:
                _apply_classification(db, clf, s['id'], slide_data, s['file_path'] or '', classify_mode)
                # Re-check if category was set (for progress count)
                after = db.conn.execute(
                    "SELECT 1 FROM slide_categories WHERE slide_id = ?", (s['id'],)
                ).fetchone()
                if after:
                    n += 1
            except Exception:
                errors += 1
                continue

    finally:
        _reclassify_progress = {"running": False, "current": total, "total": total, "done": True}
        _reclassify_lock.release()

    return {"ok": True, "reclassified": n, "errors": errors}

# ─── Clear all data ───
@app.post("/api/clear-all")
def clear_all():
    if _scan_lock.locked() or _reclassify_lock.locked() or _dedup_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="有任务正在运行（扫描/分类/去重），请等待完成后再清空数据")
    db = get_db()
    db.conn.executescript('''
        DELETE FROM collection_items;
        DELETE FROM collections;
        DELETE FROM duplicate_members; DELETE FROM duplicate_groups;
        DELETE FROM slide_categories; DELETE FROM slides;
        DELETE FROM files;
    ''')
    db.conn.commit()
    return {"ok": True}

# ─── Fix thumbnail paths ───
@app.post("/api/fix-thumbnails")
def fix_thumbnails():
    db = get_db()
    rows = db.conn.execute(
        "SELECT id, thumbnail_path FROM slides WHERE thumbnail_path != ''"
    ).fetchall()
    fixed = 0
    for row in rows:
        path = row['thumbnail_path']
        if not os.path.isabs(path):
            continue
        norm = path.replace('\\', '/')
        marker = '/thumbnails/'
        idx = norm.find(marker)
        if idx >= 0:
            rel = norm[idx + len(marker):]
            db.conn.execute(
                'UPDATE slides SET thumbnail_path = ? WHERE id = ?', (rel, row['id']))
            fixed += 1
    db.conn.commit()
    return {"ok": True, "fixed": fixed}

# ─── Open file ───
@app.post("/api/open-file")
def open_file(path: str = Query(...)):
    """Open a file with the default OS handler.
    Only allows opening files that exist in the database (previously scanned)."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    # Verify the file is in the database (was previously scanned)
    db = get_db()
    file_record = db.get_file_by_path(path)
    if not file_record:
        raise HTTPException(status_code=403, detail="只能打开已扫描入库的文件")

    os.startfile(path)
    return {"ok": True}

# ─── First-run detection ───
@app.get("/api/first-run")
def first_run():
    """Check if the app needs onboarding (no files scanned yet)."""
    db = get_db()
    file_count = db.conn.execute('SELECT COUNT(*) FROM files').fetchone()[0]
    slide_count = db.conn.execute('SELECT COUNT(*) FROM slides').fetchone()[0]
    ppt_folder = db.get_setting('ppt_folder', '')
    data_dir = get_data_dir()
    return {
        "is_first_run": file_count == 0 and slide_count == 0,
        "file_count": file_count,
        "slide_count": slide_count,
        "ppt_folder": ppt_folder,
        "data_dir": data_dir,
    }

# ─── Serve thumbnails ───
@app.get("/api/thumbnail/{file_path:path}")
def serve_thumbnail(file_path: str):
    thumb_dir = os.path.realpath(get_thumbnail_dir())
    full_path = os.path.realpath(os.path.join(thumb_dir, file_path))
    # Prevent path traversal outside the thumbnail directory
    if full_path != thumb_dir and not full_path.startswith(thumb_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid thumbnail path")
    if os.path.exists(full_path):
        return FileResponse(full_path, media_type="image/png")
    raise HTTPException(status_code=404, detail="Thumbnail not found")

# ─── Health check ───
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.1"}


if __name__ == "__main__":
    # Bundled worker mode: the PyInstaller onefile exe doubles as the dedup worker.
    # (dedup_worker.py is not a separate file inside the frozen bundle.)
    if '--dedup-worker' in sys.argv:
        sys.argv.remove('--dedup-worker')
        from dedup_worker import main as _dedup_worker_main
        _dedup_worker_main()
        sys.exit(0)

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18501)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
