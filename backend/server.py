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

from logger import get_logger

_log = get_logger(__name__)

from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

from database import Database
from interrupt import Interrupted
from scanner import (find_ppt_files, check_needs_processing, check_deleted_files,
                     process_single_file, _apply_classification,
                     discover_root, classify_candidates)
from classifier import KeywordClassifier, DEFAULT_NEGATIVE_RULES
from dedup import run_dedup
from config import get_data_dir, set_data_dir, get_db_path, get_thumbnail_dir, get_default_ppt_folder, resolve_ppt_folder, resolve_scan_roots, effective_scan_roots
from llm_classifier import batch_llm_classify

def _app_version():
    """版本号单一来源：安装包的 package.json（打包/开发都是它）。读不到退回 0.0.0。"""
    try:
        import json as _json
        pkg = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'package.json')
        with open(pkg, 'r', encoding='utf-8') as fh:
            return str(_json.load(fh).get('version') or '0.0.0')
    except Exception:
        return '0.0.0'


app = FastAPI(title="PPT Nest API", version=_app_version())

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
    kind: str = 'slide'   # 'slide' 页面收藏夹 / 'file' 文件收藏夹

class CollectionRename(BaseModel):
    name: str

class CollectionAddSlide(BaseModel):
    slide_id: int

class CollectionAddFile(BaseModel):
    file_id: int

class CollectionAddCategory(BaseModel):
    category_id: int

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

class ComposeCreate(BaseModel):
    name: str = ''

class ComposeRename(BaseModel):
    name: str

class ComposeAddItem(BaseModel):
    slide_id: int
    after_index: int | None = None

class ComposeOrder(BaseModel):
    ids: list[int] = []

class ScanRootsBody(BaseModel):
    roots: list[dict] = []


class ScanDiscoverBody(BaseModel):
    roots: list[dict] | None = None


class ScanProcessBody(BaseModel):
    paths: list[str] | None = None


class ImportFilesBody(BaseModel):
    """右键 / Finder「打开方式」/ 拖 Dock 带进来的文件，按绝对路径直接入库。"""
    paths: list[str] = []
    classify: bool = False   # 用户在导入前已经决定要不要按已有类别归类


class ComposeExport(BaseModel):
    output_path: str
    # [{"from": "XX集团", "to": "YY集团"}] —— 只在导出这一份上生效
    replacements: list[dict] = []


class ComposeTemplateFlag(BaseModel):
    is_template: bool = True


class ComposeFromTemplate(BaseModel):
    template_id: int
    name: str | None = None

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


class FilesImpactBody(BaseModel):
    file_ids: list[int] = []


@app.post("/api/files/impact")
def files_deletion_impact(body: FilesImpactBody):
    """删除前的影响面预检（单个或批量都走这里）。"""
    return get_db().deletion_impact(body.file_ids or [])


@app.post("/api/files/delete")
def files_delete(body: FilesImpactBody):
    """从素材库移除文件：只删记录、关联和缩略图，磁盘上的源 PPT 一律不动。

    移除后该路径在下次扫描里会重新变成「新文件」，可以再导入。
    """
    ids = [int(i) for i in (body.file_ids or [])]
    if not ids:
        raise HTTPException(status_code=400, detail="没有指定要移除的文件")

    db = get_db()
    thumb_root = get_thumbnail_dir()
    with db.transaction():
        res = db.delete_files(ids)
    # 事务已提交，再清缩略图：删不掉也不影响库的一致性
    thumbs = 0
    for fid in ids:
        d = os.path.join(thumb_root, str(fid))
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
            thumbs += 1
        shutil.rmtree(os.path.join(thumb_root, f'{fid}.part'), ignore_errors=True)
    _log.info('从素材库移除 %d 个文件（%d 页，%d 个缩略图目录）', res['deleted'], res['slides'], thumbs)
    return {"ok": True, "deleted": res['deleted'], "slides": res['slides'],
            "thumbs_removed": thumbs}


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
def import_categories(payload: dict | list = Body(...)):
    """Import a full category tree. Replaces all existing categories.

    两种入参都收：`{"categories": [...]}`（前端用）与裸数组（正是 `GET /api/categories/export`
    的产物），这样「导出 → 导入」拿同一份 JSON 就能自洽往返，脚本/第三方不用再包一层。
    导出时带上来的页面归属（slide_ids）与类别收藏夹成员（collection_ids）一并恢复。
    """
    if isinstance(payload, dict):
        cats = payload.get('categories') or []
    else:
        cats = payload
    if not isinstance(cats, list):
        raise HTTPException(status_code=400, detail='类别 JSON 必须是数组，或 {"categories": [...]}')
    db = get_db()
    db.reset_all_categories()
    imported = db.import_category_tree(cats, restore_members=True)
    get_classifier().reload()
    assignments = db.conn.execute('SELECT COUNT(*) FROM slide_categories').fetchone()[0]
    return {"ok": True, "imported": imported, "assignments": assignments}

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
    kind = body.kind if body.kind in ('slide', 'file', 'category') else 'slide'
    cid = db.create_collection(body.name, kind)
    return {"ok": True, "id": cid, "name": body.name, "kind": kind}

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


# ─── 文件级收藏 ───
# ─── 类别级收藏 ───
@app.get("/api/collections/{col_id}/categories")
def list_collection_categories(col_id: int):
    db = get_db()
    return [dict(c) for c in db.get_categories_by_collection(col_id)]

@app.post("/api/collections/{col_id}/categories")
def add_category_to_collection(col_id: int, body: CollectionAddCategory):
    db = get_db()
    if db.get_collection_kind(col_id) != 'category':
        raise HTTPException(status_code=400, detail="不是类别收藏夹")
    ok = db.add_category_to_collection(col_id, body.category_id)
    if not ok:
        raise HTTPException(status_code=400, detail="添加失败")
    return {"ok": True}

@app.delete("/api/collections/{col_id}/categories/{category_id}")
def remove_category_from_collection(col_id: int, category_id: int):
    db = get_db()
    db.remove_category_from_collection(col_id, category_id)
    return {"ok": True}

@app.get("/api/categories/{category_id}/collections")
def category_collections(category_id: int):
    db = get_db()
    return {"collection_ids": db.get_category_collections(category_id)}

@app.get("/api/collections/{col_id}/files")
def list_collection_files(col_id: int):
    db = get_db()
    return [dict(f) for f in db.get_files_by_collection(col_id)]

@app.post("/api/collections/{col_id}/files")
def add_file_to_collection(col_id: int, body: CollectionAddFile):
    db = get_db()
    if db.get_collection_kind(col_id) != 'file':
        raise HTTPException(status_code=400, detail="不是文件收藏夹")
    ok = db.add_file_to_collection(col_id, body.file_id)
    if not ok:
        raise HTTPException(status_code=400, detail="添加失败")
    return {"ok": True}

@app.delete("/api/collections/{col_id}/files/{file_id}")
def remove_file_from_collection(col_id: int, file_id: int):
    db = get_db()
    db.remove_file_from_collection(col_id, file_id)
    return {"ok": True}

@app.get("/api/files/{file_id}/collections")
def file_collections(file_id: int):
    """这个文件被收进了哪些收藏夹（前端勾选弹窗用）。"""
    db = get_db()
    return {"collection_ids": db.get_file_collections(file_id)}


# ─── 手动组页（compositions）─────────────────────────────────────────

_compose_progress = {"running": False, "done": False, "current": 0, "total": 0,
                     "label": "", "result": None, "error": None}
_compose_lock = threading.Lock()


def _compose_items_payload(db, comp_id):
    items = []
    for row in db.get_composition_items(comp_id):
        d = dict(row)
        d['thumbnail_url'] = _resolve_thumb_url(d.get('thumbnail_path', ''))
        items.append(d)
    return items


def _require_comp(db, comp_id):
    comp, _items = db.get_composition(comp_id)
    if not comp:
        raise HTTPException(status_code=404, detail="组稿不存在")
    return comp


@app.get("/api/compose")
def compose_list():
    db = get_db()
    return [dict(r) for r in db.list_compositions()]


@app.post("/api/compose")
def compose_create(body: ComposeCreate):
    db = get_db()
    name = (body.name or '').strip() or '未命名组稿'
    comp_id = db.create_composition(name)
    return {"id": comp_id, "name": name, "items": []}


# 注意：/api/compose/templates 必须在 /api/compose/{comp_id} 之前声明，
# 否则 "templates" 会被当成 comp_id 去转 int。
@app.get("/api/compose/templates")
def compose_templates():
    db = get_db()
    return [dict(r) for r in db.list_templates()]


@app.post("/api/compose/templates/from")
def compose_from_template(body: ComposeFromTemplate):
    """按骨架建一份新组稿：逐页按标题相似度从库里配页。"""
    db = get_db()
    _require_comp(db, body.template_id)
    import skeleton
    try:
        res = skeleton.build_from_template(db, body.template_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if body.name:
        db.rename_composition(res['comp_id'], body.name.strip())
    comp = _require_comp(db, res['comp_id'])
    return {"id": comp["id"], "name": comp["name"], "rows": res["rows"],
            "items": _compose_items_payload(db, res["comp_id"])}


@app.post("/api/compose/{comp_id}/template")
def compose_mark_template(comp_id: int, body: ComposeTemplateFlag):
    db = get_db()
    _require_comp(db, comp_id)
    db.set_composition_template(comp_id, 1 if body.is_template else 0)
    return {"ok": True, "is_template": 1 if body.is_template else 0}


@app.get("/api/compose/{comp_id}/preflight")
def compose_preflight(comp_id: int):
    """导出前体检：源文件、比例混排、会降级的页、重复页。"""
    db = get_db()
    _require_comp(db, comp_id)
    rows = db.get_composition_items(comp_id)
    if not rows:
        return {"ok": False, "pages": 0, "files": 0, "issues": [], "ratios": [], "per_page": []}
    import preflight
    return preflight.check(db, rows)


@app.get("/api/compose/export/progress")
def compose_export_progress():
    return _compose_progress


@app.get("/api/compose/{comp_id}")
def compose_detail(comp_id: int):
    db = get_db()
    comp = _require_comp(db, comp_id)
    return {"id": comp["id"], "name": comp["name"],
            "updated_at": comp["updated_at"], "items": _compose_items_payload(db, comp_id)}


@app.put("/api/compose/{comp_id}")
def compose_rename(comp_id: int, body: ComposeRename):
    db = get_db()
    _require_comp(db, comp_id)
    name = (body.name or '').strip() or '未命名组稿'
    db.rename_composition(comp_id, name)
    return {"ok": True, "name": name}


@app.delete("/api/compose/{comp_id}")
def compose_delete(comp_id: int):
    db = get_db()
    _require_comp(db, comp_id)
    db.delete_composition(comp_id)
    return {"ok": True}


@app.post("/api/compose/{comp_id}/items")
def compose_add_item(comp_id: int, body: ComposeAddItem):
    db = get_db()
    _require_comp(db, comp_id)
    try:
        item_id = db.add_composition_item(comp_id, body.slide_id, body.after_index)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "item_id": item_id,
            "items": _compose_items_payload(db, comp_id)}


@app.put("/api/compose/{comp_id}/items/order")
def compose_reorder(comp_id: int, body: ComposeOrder):
    db = get_db()
    _require_comp(db, comp_id)
    db.reorder_composition_items(comp_id, body.ids)
    return {"ok": True, "items": _compose_items_payload(db, comp_id)}


@app.delete("/api/compose/{comp_id}/items/{item_id}")
def compose_remove_item(comp_id: int, item_id: int):
    db = get_db()
    _require_comp(db, comp_id)
    db.remove_composition_item(comp_id, item_id)
    return {"ok": True, "items": _compose_items_payload(db, comp_id)}


@app.post("/api/compose/{comp_id}/export")
def compose_export(comp_id: int, body: ComposeExport):
    """把组稿拼成一份 PPTX。多源时耗时较长，走后台线程 + 进度轮询。"""
    db = get_db()
    comp = _require_comp(db, comp_id)
    rows = db.get_composition_items(comp_id)
    if not rows:
        raise HTTPException(status_code=400, detail="组稿里还没有页面")

    output_path = (body.output_path or '').strip()
    if not output_path:
        raise HTTPException(status_code=400, detail="没有指定输出位置")
    if not output_path.lower().endswith('.pptx'):
        output_path += '.pptx'
    out_dir = os.path.dirname(os.path.abspath(output_path))
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"输出目录不可写：{e}")

    if not _compose_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="已有一个导出任务在跑")

    items = [dict(r) for r in rows]
    _compose_progress.update({"running": True, "done": False, "current": 0,
                              "total": len(items), "label": "准备中",
                              "result": None, "error": None})

    def _progress(current, total, label):
        _compose_progress.update({"current": current, "total": total, "label": label})

    def _worker():
        try:
            import composer
            rules = [{'from': str(r.get('from', '')), 'to': str(r.get('to', ''))}
                     for r in (body.replacements or [])
                     if str(r.get('from', '')).strip()]
            stats = composer.export_composition(
                items, output_path, progress=_progress,
                replacements=rules or None,
            )
            _compose_progress.update({"running": False, "done": True,
                                      "current": len(items), "total": len(items),
                                      "label": "完成", "result": stats, "error": None})
        except Exception as e:
            import traceback
            traceback.print_exc()
            _compose_progress.update({"running": False, "done": True,
                                      "label": "失败", "error": str(e)})
        finally:
            _compose_lock.release()

    # DB 连接是单例且 check_same_thread=False，这里不再开连接，直接复用 items 快照
    threading.Thread(target=_worker, daemon=True).start()
    return {"ok": True, "started": True, "file_name": os.path.basename(output_path),
            "output_path": output_path, "comp_name": comp["name"]}


# ─── Scan ───

_scan_progress = {"running": False, "current": 0, "total": 0, "current_file": "", "done": False, "scan_id": 0,
                  "pages_total": 0, "pages_done": 0, "pages_unknown": 0,
                  "page_current": 0, "page_current_total": 0, "elapsed": 0.0}
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

def _perf_engine():
    try:
        import libreoffice
        return 'render' if libreoffice.is_available() else 'placeholder'
    except Exception:
        return 'render'


def estimate_import(db, n_files):
    """估算导入耗时。

    不写死常量：优先用本机真实样本（中位数），没有样本才用保守默认。
    不同电脑的 LibreOffice 冷启动能差 5-10 倍，所以「首次估算」一律往高了给，
    等第一批导完就换成实测值。
    """
    import statistics
    engine = _perf_engine()
    mode = (db.get_setting('classify_mode', 'hybrid') or 'hybrid').lower()
    llm = mode in ('llm', 'hybrid')
    samples = db.get_perf_samples(limit=60)
    same = [x for x in samples if (x.get('engine') or 'render') == engine and bool(x.get('llm')) == llm]
    if len(same) < 3:
        same = [x for x in samples if (x.get('engine') or 'render') == engine]
    if len(same) >= 3:
        per_file = statistics.median([x['seconds'] for x in same])
        return {'seconds': per_file * max(n_files, 0), 'per_file': round(per_file, 2),
                'basis': 'machine', 'samples': len(same), 'engine': engine}
    if engine == 'placeholder':
        default = 0.2          # 没装 LibreOffice，只写库不渲染
    elif mode == 'llm':
        default = 20.0         # 每页都要调大模型
    elif llm:
        default = 8.0          # 混合：只有低置信度的页走模型
    else:
        default = 6.0          # 纯关键词：主要是 LibreOffice 转换
    return {'seconds': default * max(n_files, 0), 'per_file': default,
            'basis': 'default', 'samples': 0, 'engine': engine}


@app.get("/api/scan/check")
def scan_check():
    """概览（兼容老接口）：多个扫描位置汇总。"""
    db = get_db()
    roots = resolve_scan_roots(db)
    enabled = [r['path'] for r in roots if r['enabled']]
    root_infos = [discover_root(p) for p in enabled]
    newest_only = db.get_setting('scan_newest_only', '1') not in ('0', 'false', 'False', '')
    # 同名/同系列去重改由前端清单控制（用户要能看到被跳过的那份并手动勾选），
    # 后端不再在这里丢弃，只把偏好回传给前端做默认勾选。
    entries, dropped = classify_candidates(db, root_infos, newest_only=False)
    pending = [e for e in entries if e['status'] in ('new', 'changed', 'moved', 'moved_changed')]
    deleted = check_deleted_files(enabled[0] if enabled else '', db)
    return {
        "ppt_folder": enabled[0] if enabled else '',
        "roots": roots,
        "newest_only": newest_only,
        "dropped_same_name": len(dropped),
        "total_files": len(entries),
        "new_files": [{"path": e['path'], "name": e['name'], "status": e['status'],
                       "size": e['bytes']} for e in pending],
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


@app.put("/api/scan/roots")
def update_scan_roots(body: ScanRootsBody):
    """保存扫描位置列表（路径 + 开关）。"""
    db = get_db()
    cleaned = []
    for item in body.roots or []:
        path = (item.get('path') or '').strip()
        if not path:
            continue
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isdir(path):
            raise HTTPException(status_code=400, detail=f"文件夹不存在：{path}")
        if any(r['path'] == path for r in cleaned):
            continue
        cleaned.append({'path': path, 'enabled': bool(item.get('enabled', True))})
    if not cleaned:
        raise HTTPException(status_code=400, detail="至少要保留一个扫描位置")
    db.set_setting('scan_roots', json.dumps(cleaned, ensure_ascii=False))
    # 兼容字段：第一个启用的位置
    first = next((r['path'] for r in cleaned if r['enabled']), cleaned[0]['path'])
    db.set_setting('ppt_folder', first)
    return {"ok": True, "roots": cleaned}


@app.post("/api/scan/discover")
def scan_discover(body: ScanDiscoverBody | None = None):
    """只读发现：列出会发生什么，等用户确认后再处理。"""
    db = get_db()
    if body and body.roots:
        roots = [{'path': os.path.abspath(os.path.expanduser(r.get('path') or '')),
                  'enabled': bool(r.get('enabled', True))} for r in body.roots if (r.get('path') or '').strip()]
    else:
        roots = resolve_scan_roots(db)
    enabled, nested_roots = effective_scan_roots(roots)
    root_infos = [discover_root(p) for p in enabled]
    newest_only = db.get_setting('scan_newest_only', '1') not in ('0', 'false', 'False', '')
    # 同名/同系列去重改由前端清单控制（用户要能看到被跳过的那份并手动勾选），
    # 后端不再在这里丢弃，只把偏好回传给前端做默认勾选。
    entries, dropped = classify_candidates(db, root_infos, newest_only=False)

    groups = []
    for info in root_infos:
        rows = [e for e in entries if e['root'] == info['root']]
        groups.append({
            'root': info['root'],
            'exists': info['exists'],
            'files': rows,
            'skipped': info['skipped'],
        })

    pending = [e for e in entries if e['status'] in ('new', 'changed', 'moved', 'moved_changed')]
    skipped_summary = {}
    for info in root_infos:
        for k, v in info['skipped'].items():
            skipped_summary[k] = skipped_summary.get(k, 0) + v['count']
    if dropped:
        skipped_summary['同名旧版本'] = len(dropped)
    return {
        'roots': roots,
        'groups': groups,
        'nested_roots': nested_roots,
        'newest_only': newest_only,
        'estimate': estimate_import(db, len(pending)),
        'dropped_same_name': [
            {'name': e['name'], 'path': e['path'], 'mtime': e['mtime'],
             'root': e['root'], 'rel': e['rel']}
            for e in sorted(dropped, key=lambda x: -x['mtime'])[:50]
        ],
        'summary': {
            'new': sum(1 for e in entries if e['status'] == 'new'),
            'changed': sum(1 for e in entries if e['status'] == 'changed'),
            'moved': sum(1 for e in entries if e['status'] in ('moved', 'moved_changed')),
            'known': sum(1 for e in entries if e['status'] == 'known'),
            'pending': len(pending),
            'bytes': sum(e['bytes'] for e in pending),
            'skipped': skipped_summary,
        },
    }


@app.post("/api/scan/process")
def scan_process(body: ScanProcessBody | None = None):
    """处理待入库的文件。不带 paths 时处理全部；带了就只处理勾选的那些。"""
    global _scan_progress
    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="正在扫描或导入中")

    try:
        db = get_db()
        effective_roots, _nested = effective_scan_roots(resolve_scan_roots(db))
        root_infos = [discover_root(p) for p in effective_roots]
        newest_only = db.get_setting('scan_newest_only', '1') not in ('0', 'false', 'False', '')
        # 去重改由前端清单决定要不要勾，后端不再静默丢弃同名旧版本
        entries, dropped = classify_candidates(db, root_infos, newest_only=False)

        wanted = None
        if body and body.paths:
            wanted = {os.path.abspath(p) for p in body.paths}
            allowed = [e for e in entries if e['path'] in wanted]
        else:
            allowed = [e for e in entries if e['status'] in ('new', 'changed', 'moved', 'moved_changed')]

        # 先认领移动/改名：只改路径，不重复入库
        todo = []
        for e in allowed:
            if e['status'] in ('moved', 'moved_changed'):
                try:
                    db.update_file_path(e['file_id'], e['path'])
                except Exception as ex:
                    _log.warning('认领移动文件失败 %s: %s', e['path'], ex)
            if e['status'] in ('new', 'changed', 'moved_changed'):
                todo.append(e)

        if not todo:
            return {"ok": True, "processed": 0, "total_slides": 0, "errors": [],
                    "cancelled": False,
                    "moved": sum(1 for e in allowed if e['status'] in ('moved', 'moved_changed'))}
        if len(todo) > 500:
            raise HTTPException(status_code=400, detail=f"一次最多处理 500 个文件（这次要处理 {len(todo)} 个），请少勾一些")

        scan_id = int(time.time() * 1000)
        # 先按包结构快速数一遍总页数（.pptx 毫秒级；.ppt 未知，解析到时再补）
        from ppt_parser import count_slides_fast
        est_by_path = {}
        pages_total = 0
        pages_unknown = 0
        for e in todo:
            n = count_slides_fast(e['path'])
            est_by_path[e['path']] = n
            if n is None:
                pages_unknown += 1
            else:
                pages_total += n

        _scan_progress = {
            "running": True, "current": 0, "total": len(todo),
            "current_file": "", "done": False, "scan_id": scan_id,
            "started_at": time.time(), "elapsed": 0.0,
            "pages_total": pages_total, "pages_done": 0, "pages_unknown": pages_unknown,
            "page_current": 0, "page_current_total": 0,
        }

        def _page_cb(idx, total):
            """每渲染完一页更新一次，前端据此按页走进度条。"""
            _scan_progress["page_current"] = int(idx or 0)
            if total:
                _scan_progress["page_current_total"] = int(total)
            _scan_progress["elapsed"] = round(time.time() - _scan_progress["started_at"], 1)
        perf_engine = _perf_engine()
        perf_llm = (db.get_setting('classify_mode', 'hybrid') or 'hybrid').lower() in ('llm', 'hybrid')

        classifier = get_classifier()
        thumb_dir = get_thumbnail_dir()
        total_slides = 0
        errors = []
        processed_count = 0
        cancelled = False

        def _is_cancelled():
            """用户点了取消：scan_cancel() 会把当前 scan_id 置 0。"""
            return _scan_progress.get("scan_id") != scan_id

        for i, entry in enumerate(todo):
            if _is_cancelled():
                cancelled = True
                _scan_progress["cancelled"] = True
                break  # cancelled
            fp = entry['path']
            _scan_progress["current"] = i + 1
            _scan_progress["current_file"] = entry['name']
            _scan_progress["page_current"] = 0
            _scan_progress["page_current_total"] = 0
            t_file = time.time()
            n, err = 0, None
            try:
                # 一个文件一个事务：中途被取消就整体撤回，不留半截数据
                with db.transaction():
                    n, err = process_single_file(fp, db, classifier, thumb_dir,
                                                 cancel=_is_cancelled, page_cb=_page_cb)
            except Interrupted:
                cancelled = True
                _scan_progress["cancelled"] = True
                _log.info('导入被中断，已撤回「%s」的全部写入', entry['name'])
                break
            except Exception as e:
                errors.append({"file": entry['name'], "error": str(e)})
            else:
                if err:
                    errors.append({"file": entry['name'], "error": err})
                else:
                    total_slides += n
                    processed_count += 1
                    # 页数对账：以真正入库的页数为准，估算偏差就地修正
                    _scan_progress["pages_done"] += n
                    est = est_by_path.get(fp)
                    if est is None:
                        _scan_progress["pages_total"] += n
                        _scan_progress["pages_unknown"] = max(0, _scan_progress["pages_unknown"] - 1)
                    elif est != n:
                        _scan_progress["pages_total"] += (n - est)
            # 记一条本机样本：下次估算用（失败的不算）
            if not err:
                try:
                    db.add_perf_sample(time.time() - t_file, n, perf_engine, perf_llm)
                except Exception:
                    pass
            _scan_progress["elapsed"] = round(time.time() - _scan_progress["started_at"], 1)

    finally:
        _scan_progress = {
            "running": False, "current": _scan_progress.get("current", 0),
            "total": _scan_progress.get("total", 0), "current_file": "", "done": True,
            "scan_id": _scan_progress.get("scan_id", 0),
            "cancelled": bool(_scan_progress.get("cancelled", False)),
            "pages_total": _scan_progress.get("pages_total", 0),
            "pages_done": _scan_progress.get("pages_done", 0),
            "pages_unknown": _scan_progress.get("pages_unknown", 0),
            "page_current": _scan_progress.get("page_current", 0),
            "page_current_total": _scan_progress.get("page_current_total", 0),
            "elapsed": _scan_progress.get("elapsed", 0.0),
        }
        _scan_lock.release()

    return {
        "ok": True,
        "processed": processed_count,
        "total_slides": total_slides,
        "errors": errors,
        "cancelled": cancelled,
    }

# ─── 右键 / Finder「打开方式」/ 拖 Dock 带进来的文件（不走扫描位置） ───

_PPT_EXT = ('.pptx', '.ppt')


def _clean_open_path(raw):
    """macOS/Windows 递进来的路径可能带引号、file:// 前缀或 %20 编码。"""
    from urllib.parse import unquote, urlparse
    s = (raw or '').strip().strip('"').strip("'").strip()
    if s.lower().startswith('file://'):
        s = unquote(urlparse(s).path)
    return os.path.abspath(os.path.expanduser(s))


@app.post("/api/import/check")
def import_check(body: ImportFilesBody):
    """导入前先看一眼：哪些是新的、哪些已经在库里、哪些根本不是 PPT。"""
    db = get_db()
    from ppt_parser import count_slides_fast
    out, seen = [], set()
    for raw in (body.paths or []):
        p = _clean_open_path(raw)
        if p in seen:
            continue
        seen.add(p)
        name = os.path.basename(p)
        item = {'path': p, 'name': name, 'status': 'new',
                'slides': None, 'file_id': None, 'reason': ''}
        if not p.lower().endswith(_PPT_EXT):
            item.update(status='invalid', reason='不是 PPT 文件')
        elif not os.path.isfile(p):
            item.update(status='invalid', reason='文件不存在或已被移动')
        elif not os.access(p, os.R_OK):
            item.update(status='invalid', reason='没有读取权限')
        else:
            existing = db.get_file_by_path(p)
            if existing:
                item.update(status='known', file_id=existing['id'],
                            slides=existing['total_slides'])
            else:
                try:
                    item['slides'] = count_slides_fast(p)
                except Exception:
                    item['slides'] = None
        out.append(item)
    return {'files': out, 'has_categories': len(db.get_all_categories()) > 0}


@app.post("/api/import/files")
def import_files(body: ImportFilesBody):
    """按绝对路径直接入库（不依赖扫描位置）。

    同步执行，前端并行轮询 /api/scan/progress 看页级进度。
    已在库里的同路径文件一律跳过：重新解析会先删掉它所有页，连带清空组稿/收藏夹里引用它的项。
    """
    global _scan_progress
    paths = []
    for raw in (body.paths or []):
        p = _clean_open_path(raw)
        if p and p not in paths:
            paths.append(p)
    if not paths:
        raise HTTPException(status_code=400, detail='没有要导入的文件')
    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail='正在扫描或导入中')

    db = get_db()
    imported, skipped, errors = [], [], []
    try:
        todo = []
        for p in paths:
            name = os.path.basename(p)
            if not p.lower().endswith(_PPT_EXT) or not os.path.isfile(p):
                errors.append({'file': name, 'path': p,
                               'error': '不是可导入的 PPT 文件，或文件不存在'})
                continue
            existing = db.get_file_by_path(p)
            if existing:
                skipped.append({'file': name, 'path': p, 'file_id': existing['id'],
                                'slides': existing['total_slides'], 'reason': '已在库里'})
                continue
            todo.append((p, name))

        if not todo:
            return {'ok': True, 'imported': [], 'skipped': skipped, 'errors': errors,
                    'total_slides': 0}

        from ppt_parser import count_slides_fast
        est_by_path, pages_total, pages_unknown = {}, 0, 0
        for p, _ in todo:
            n = None
            try:
                n = count_slides_fast(p)
            except Exception:
                n = None
            est_by_path[p] = n
            if n is None:
                pages_unknown += 1
            else:
                pages_total += n

        scan_id = int(time.time() * 1000)
        _scan_progress = {
            "running": True, "current": 0, "total": len(todo),
            "current_file": "", "done": False, "scan_id": scan_id,
            "started_at": time.time(), "elapsed": 0.0,
            "pages_total": pages_total, "pages_done": 0, "pages_unknown": pages_unknown,
            "page_current": 0, "page_current_total": 0,
            "kind": "import",
        }

        def _page_cb(idx, total):
            _scan_progress["page_current"] = int(idx or 0)
            if total:
                _scan_progress["page_current_total"] = int(total)
            _scan_progress["elapsed"] = round(time.time() - _scan_progress["started_at"], 1)

        def _is_cancelled():
            return _scan_progress.get("scan_id") != scan_id

        classifier = get_classifier()
        thumb_dir = get_thumbnail_dir()
        total_slides = 0

        for i, (fp, name) in enumerate(todo):
            if _is_cancelled():
                break
            _scan_progress["current"] = i + 1
            _scan_progress["current_file"] = name
            _scan_progress["page_current"] = 0
            _scan_progress["page_current_total"] = 0
            try:
                with db.transaction():
                    n, err = process_single_file(
                        fp, db, classifier, thumb_dir,
                        cancel=_is_cancelled, page_cb=_page_cb,
                        classify=bool(body.classify))
            except Interrupted:
                _scan_progress["cancelled"] = True
                break
            except Exception as e:
                errors.append({'file': name, 'path': fp, 'error': str(e)})
                continue
            if err:
                errors.append({'file': name, 'path': fp, 'error': err})
                continue
            total_slides += n
            _scan_progress["pages_done"] += n
            est = est_by_path.get(fp)
            if est is None:
                _scan_progress["pages_total"] += n
                _scan_progress["pages_unknown"] = max(0, _scan_progress["pages_unknown"] - 1)
            elif est != n:
                _scan_progress["pages_total"] += (n - est)
            rec = db.get_file_by_path(fp)
            imported.append({'file': name, 'path': fp, 'file_id': rec['id'] if rec else None,
                             'slides': n})
            _scan_progress["elapsed"] = round(time.time() - _scan_progress["started_at"], 1)

        # 归了多少页（只统计刚落库的这些文件）
        if body.classify:
            for it in imported:
                if it['file_id'] is None:
                    it['classified'] = 0
                    continue
                row = db.conn.execute(
                    '''SELECT COUNT(*) AS c FROM slide_categories
                       WHERE slide_id IN (SELECT id FROM slides WHERE file_id = ?)''',
                    (it['file_id'],)).fetchone()
                it['classified'] = row['c'] if row else 0
    finally:
        _scan_progress = {
            "running": False, "current": _scan_progress.get("current", 0),
            "total": _scan_progress.get("total", 0), "current_file": "", "done": True,
            "scan_id": _scan_progress.get("scan_id", 0),
            "cancelled": bool(_scan_progress.get("cancelled", False)),
            "pages_total": _scan_progress.get("pages_total", 0),
            "pages_done": _scan_progress.get("pages_done", 0),
            "pages_unknown": _scan_progress.get("pages_unknown", 0),
            "page_current": _scan_progress.get("page_current", 0),
            "page_current_total": _scan_progress.get("page_current_total", 0),
            "elapsed": _scan_progress.get("elapsed", 0.0),
            "kind": "import",
        }
        _scan_lock.release()

    return {'ok': True, 'imported': imported, 'skipped': skipped,
            'errors': errors, 'total_slides': total_slides}


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
    scan_newest_only: bool | None = None,
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
    if scan_newest_only is not None:
        db.set_setting('scan_newest_only', '1' if scan_newest_only else '0')
    return {"ok": True}

@app.post("/api/scan/cleanup")
def scan_cleanup(body: ScanProcessBody | None = None):
    """清掉磁盘上已经不存在的文件记录。带了 paths 就只清这些。"""
    db = get_db()
    deleted = check_deleted_files('', db)
    if body and body.paths:
        wanted = {os.path.abspath(p) for p in body.paths}
        deleted = [f for f in deleted if f['file_path'] in wanted]
    for f in deleted:
        db.delete_file_by_path(f['file_path'])
    return {"ok": True, "cleaned": len(deleted),
            "names": [f['file_name'] for f in deleted]}

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
    """是否需要走首次引导。

    用一次性标记 onboarding_done 判断，而不是「库里有没有文件」——
    用户照着引导导入示例、看完再删掉，库又空了，按文件数判断会再弹一次引导。
    老用户（库里已有数据）视为已完成，避免升级后被弹一次。
    """
    db = get_db()
    file_count = db.conn.execute('SELECT COUNT(*) FROM files').fetchone()[0]
    slide_count = db.conn.execute('SELECT COUNT(*) FROM slides').fetchone()[0]
    done = db.get_setting('onboarding_done', '') == '1'
    if not done and (file_count > 0 or slide_count > 0):
        db.set_setting('onboarding_done', '1')
        done = True
    return {
        "is_first_run": not done,
        "onboarding_done": done,
        "file_count": file_count,
        "slide_count": slide_count,
        "ppt_folder": db.get_setting('ppt_folder', ''),
        "data_dir": get_data_dir(),
    }


@app.post("/api/onboarding/complete")
def onboarding_complete():
    get_db().set_setting('onboarding_done', '1')
    return {"ok": True}


@app.post("/api/onboarding/reset")
def onboarding_reset():
    """调试用：把引导重置为未完成。"""
    get_db().set_setting('onboarding_done', '0')
    return {"ok": True}

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
    return {"status": "ok", "version": _app_version()}


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
