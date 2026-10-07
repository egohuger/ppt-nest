# 重复页检测与自动隐藏非主版本

import hashlib
import time
import bisect
import logging
from collections import defaultdict

from rapidfuzz import fuzz

from logger import get_logger

_log = get_logger(__name__)

EMPTY_HASH = hashlib.md5(''.encode('utf-8')).hexdigest()

# ── Text fingerprint for fast Jaccard pre-filter ──

def _text_fingerprint(text, n=3):
    """Character n-gram set for fast Jaccard similarity pre-filter.
    Works for both Chinese (char n-grams) and English (char trigrams).
    """
    text = text.lower()
    if len(text) < n:
        return frozenset([text])
    return frozenset(text[i:i+n] for i in range(len(text) - n + 1))

def _jaccard(set1, set2):
    if not set1 or not set2:
        return 0.0
    inter = len(set1 & set2)
    if inter == 0:
        return 0.0
    return inter / len(set1 | set2)

# ── Primary picker ──

def _pick_primary_index(slides):
    """优先保留文件名较早、页码较小的作为主版本。"""
    ordered = sorted(
        enumerate(slides),
        key=lambda x: (
            x[1]['file_name'] if 'file_name' in x[1].keys() else '',
            x[1]['slide_number'],
        ),
    )
    return ordered[0][0]


# ── Similarity detection with length bucketing + fingerprint pre-filter ──

def _find_similar_from_pools(target_candidates, all_candidates, threshold,
                             progress_callback=None):
    """Fast similarity detection using length bucketing + character n-gram pre-filter.
    Only runs expensive fuzz.ratio() on pairs that pass both gates.
    """
    similar_groups = []
    used_ids = set()

    # Pre-compute fingerprints and text lengths for all candidates
    fp_cache = {}
    len_cache = {}
    for c in all_candidates:
        cid = c['id']
        text = c['text_content'] or ''
        fp_cache[cid] = _text_fingerprint(text)
        len_cache[cid] = len(text)

    # Sort all_candidates by text length for bisect windowing
    all_sorted = sorted(all_candidates, key=lambda s: len_cache[s['id']])
    all_lengths = [len_cache[s['id']] for s in all_sorted]
    id_to_idx = {s['id']: i for i, s in enumerate(all_sorted)}

    total = len(target_candidates)
    checked = 0
    last_report = 0
    length_floor = 0.45
    jaccard_floor = max(0.15, threshold - 0.35)  # loose pre-filter

    for i, tc in enumerate(target_candidates):
        tc_id = tc['id']
        if tc_id in used_ids:
            continue

        group = [tc]
        tc_len = len_cache[tc_id]
        tc_fp = fp_cache[tc_id]
        tc_text = tc['text_content'] or ''

        # Bisect window: only consider candidates within length ratio bounds
        lo_len = int(tc_len * length_floor)
        hi_len = int(tc_len / length_floor)
        lo = bisect.bisect_left(all_lengths, lo_len)
        hi = bisect.bisect_right(all_lengths, hi_len)

        for j in range(lo, hi):
            ac = all_sorted[j]
            ac_id = ac['id']
            if ac_id == tc_id or ac_id in used_ids:
                continue

            # Gate 1: Jaccard pre-filter (fast set operation)
            if _jaccard(tc_fp, fp_cache[ac_id]) < jaccard_floor:
                continue

            # Gate 2: fuzz.ratio (expensive but accurate)
            ac_text = ac['text_content'] or ''
            sim = fuzz.ratio(tc_text, ac_text) / 100.0
            checked += 1

            if sim >= threshold:
                group.append(ac)
                used_ids.add(ac_id)

            # Periodic progress + GIL yield (based on outer loop, not fuzz count)
            if progress_callback and i - last_report >= 50:
                progress_callback(
                    i, total,
                    f"相似度检测中… {i}/{total} 目标页，已发现 {len(similar_groups)} 组")
                last_report = i
                time.sleep(0)

        if len(group) >= 2:
            used_ids.add(tc_id)
            similar_groups.append({
                'type': 'similar', 'slides': group, 'similarity': threshold})

    if progress_callback:
        progress_callback(
            total, total,
            f"相似度检测完成：{checked} 对比较，发现 {len(similar_groups)} 组")

    return similar_groups, checked


# ── Main dedup entry ──

def run_dedup(db, auto_hide=False, progress_callback=None, incremental=False):
    """
    运行去重并写入数据库。
    auto_hide=False 时不自动隐藏，由用户手动操作。
    incremental=True 时只处理新入库的页面（不重建已有组）。
    返回 (exact_count, similar_count, hidden_count)
    """
    if incremental:
        last_max_id = int(db.get_setting('dedup_last_max_slide_id', '0'))
        all_slides = db.get_all_slides(include_hidden=True)
        new_slides = [s for s in all_slides if s['id'] > last_max_id]
        if not new_slides:
            _log.info("Incremental dedup: no new slides to process")
            return 0, 0, 0

        # Keep existing groups, only add new ones
        result = _run_dedup_on_slides(
            db, new_slides, all_slides, auto_hide, progress_callback)

        # Update watermark: all slides up to max have been checked
        max_id = max((s['id'] for s in all_slides), default=0)
        db.set_setting('dedup_last_max_slide_id', str(max_id))
        return result
    else:
        db.clear_duplicate_groups()
        all_slides = db.get_all_slides(include_hidden=True)

        result = _run_dedup_on_slides(
            db, all_slides, all_slides, auto_hide, progress_callback)

        # Update watermark after full dedup too
        max_id = max((s['id'] for s in all_slides), default=0)
        db.set_setting('dedup_last_max_slide_id', str(max_id))
        return result


# ── Core dedup logic with batched DB writes ──

def _run_dedup_on_slides(db, target_slides, all_slides, auto_hide,
                         progress_callback):
    """Core dedup logic. All DB writes wrapped in a single transaction for speed."""
    if progress_callback:
        progress_callback(0, 100, "正在检测完全重复…")

    # Exact dedup: group by content hash
    hash_groups = defaultdict(list)
    for s in all_slides:
        h = s['content_hash']
        if h and h != EMPTY_HASH:
            hash_groups[h].append(s)

    target_ids = {s['id'] for s in target_slides}
    exact = []
    for g in hash_groups.values():
        if len(g) >= 2 and any(s['id'] in target_ids for s in g):
            exact.append({'type': 'exact', 'slides': g, 'similarity': 1.0})

    if progress_callback:
        progress_callback(
            3, 100,
            f"完全重复检测完成：{len(exact)} 组，开始检测高度相似…")

    threshold = float(db.get_setting('dedup_threshold', '0.85'))

    # Build candidate pools for similarity phase
    seen_hashes = set()
    all_candidates = []
    target_candidates = []

    for s in all_slides:
        text = s['text_content'] or ''
        if len(text.strip()) < 20:
            continue
        if s['content_hash'] in seen_hashes:
            continue
        seen_hashes.add(s['content_hash'])
        all_candidates.append(s)
        if s['id'] in target_ids:
            target_candidates.append(s)

    total_target = len(target_candidates)
    def _sim_progress_cb(current, total, msg):
        pct = 3 + int(94 * current / max(total, 1))
        progress_callback(pct, 100, msg)

    similar_groups, _ = _find_similar_from_pools(
        target_candidates, all_candidates, threshold, _sim_progress_cb)

    # ── Single transaction for all writes ──
    db.conn.execute("BEGIN IMMEDIATE")
    try:
        # Map slides already belonging to a group (empty in full mode, since
        # clear_duplicate_groups() ran first). Prevents incremental dedup from
        # putting one slide into multiple groups.
        existing_member = {}
        for r in db.conn.execute('SELECT slide_id, group_id FROM duplicate_members'):
            existing_member[r['slide_id']] = r['group_id']

        written = 0
        for g in exact + similar_groups:
            slides = g['slides']
            gid = None
            for s in slides:
                if s['id'] in existing_member:
                    gid = existing_member[s['id']]
                    break
            new_slides = [s for s in slides if s['id'] not in existing_member]
            if not new_slides:
                continue  # fully covered by previous groups

            if gid is None:
                cur = db.conn.execute(
                    'INSERT INTO duplicate_groups (group_type) VALUES (?)',
                    (g['type'],))
                gid = cur.lastrowid
                primary_idx = _pick_primary_index(new_slides)
                for idx, s in enumerate(new_slides):
                    db.conn.execute(
                        'INSERT INTO duplicate_members (group_id, slide_id, similarity, is_primary) VALUES (?,?,?,?)',
                        (gid, s['id'], g['similarity'], int(idx == primary_idx)))
            else:
                # Merge into existing group — keep its current primary
                for s in new_slides:
                    db.conn.execute(
                        'INSERT INTO duplicate_members (group_id, slide_id, similarity, is_primary) VALUES (?,?,?,?)',
                        (gid, s['id'], g['similarity'], 0))
            for s in new_slides:
                existing_member[s['id']] = gid
            written += 1

        hidden = 0
        if auto_hide:
            if progress_callback:
                progress_callback(97, 100, "正在隐藏非主版本…")
            cur = db.conn.execute(
                'UPDATE duplicate_members SET is_hidden=1 WHERE is_primary=0 AND is_hidden=0')
            hidden = cur.rowcount

        db.conn.commit()
    except Exception:
        db.conn.rollback()
        raise

    _log.info("Dedup complete: %d exact, %d similar, %d hidden",
              len(exact), len(similar_groups), hidden)
    return len(exact), len(similar_groups), hidden
