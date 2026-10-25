"""组稿骨架：把一份定稿组稿存成样板，下次按页面顺序自动配页。

不用大模型：按每页的标题（+正文前 120 字）在素材库里做字符串相似度匹配，
取最高分那页。原页还在库里且没被换掉时，通常就是原页自己。

这是「AI 智能组稿」的中间态 —— 换成语义匹配时，只需要替换本文件的
`best_match()`，接口和界面都不用动。
"""
from rapidfuzz import fuzz, process

# 低于这个分就标「匹配得勉强」，让用户在界面上优先复核
WEAK_THRESHOLD = 45.0


def _query_of(page):
    title = (page['title'] or '').strip()
    body = (page['text_content'] or '').strip()[:120]
    return (title + ' ' + body).strip()


def best_match(page, candidates, choices):
    """返回 (slide_id, score) —— 分最高的候选，没有则 (None, 0)。"""
    q = _query_of(page)
    if not q:
        # 纯图页没有标题可匹配：原页还在就用原页，别硬凑
        for c in candidates:
            if c['id'] == page['slide_id']:
                return page['slide_id'], 100.0
        return None, 0.0
    if not choices:
        return None, 0.0
    res = process.extractOne(q, choices, scorer=fuzz.WRatio)
    if not res:
        return None, 0.0
    return candidates[res[2]]['id'], float(res[1])


def build_from_template(db, template_id):
    """按骨架建一份新组稿。返回 {comp_id, rows:[{...匹配结果}]}。"""
    pages = db.get_template_pages(template_id)
    if not pages:
        raise ValueError('这份骨架里没有页面')

    candidates = [dict(r) for r in db.get_all_slides(include_hidden=False)]
    choices = []
    for c in candidates:
        q = _query_of(c)
        choices.append(q if q else f"第{c['slide_number']}页 {c['file_name'] or ''}")

    comp_id = db.create_composition(f"{(db.get_composition(template_id)[0]['name'] or '骨架')}-副本")
    rows = []
    for idx, page in enumerate(pages, start=1):
        slide_id, score = best_match(page, candidates, choices)
        skel_label = (page['title'] or '').strip() or f"{page['file_name']} 第{page['slide_number']}页"
        if slide_id is None:
            rows.append({'index': idx, 'skeleton_title': skel_label,
                         'matched_title': '', 'score': 0, 'status': 'missing'})
            continue
        db.add_composition_item(comp_id, slide_id)
        hit = next(c for c in candidates if c['id'] == slide_id)
        if slide_id == page['slide_id']:
            status = 'exact'
        elif score < WEAK_THRESHOLD:
            status = 'weak'
        else:
            status = 'similar'
        hit_label = (hit['title'] or '').strip() or f"第{hit['slide_number']}页"
        rows.append({'index': idx, 'skeleton_title': skel_label,
                     'matched_title': hit_label,
                     'matched_file': hit['file_name'] or '',
                     'matched_page': hit['slide_number'],
                     'score': round(score, 1), 'status': status})
    return {'comp_id': comp_id, 'rows': rows}
