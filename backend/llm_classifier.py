# 智谱等大模型幻灯片归类

import json
import re
import logging
import requests

from logger import get_logger

_log = get_logger(__name__)

ZHIPU_CHAT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
DEFAULT_MODEL = "glm-4-flash"


def _build_category_catalog(db):
    """返回供模型选择的类别列表 [{id, label}, ...]
    递归遍历所有层级，label 用 ' > ' 连接完整路径。"""
    items = []

    def _walk(cat_id, prefix):
        children = db.get_children(cat_id)
        if not children:
            # Leaf node — add to catalog
            items.append({'id': cat_id, 'label': prefix})
            return
        for ch in children:
            label = f"{prefix} > {ch['name']}" if prefix else ch['name']
            _walk(ch['id'], label)

    for root in db.get_root_categories():
        children = db.get_children(root['id'])
        if children:
            for ch in children:
                _walk(ch['id'], f"{root['name']} > {ch['name']}")
        else:
            items.append({'id': root['id'], 'label': root['name']})
    return items


def _call_openai_compatible(api_key, messages, model=DEFAULT_MODEL, base_url=None):
    url = (base_url or ZHIPU_CHAT_URL).rstrip('/')
    if not url.endswith('/chat/completions'):
        url = url + '/chat/completions' if 'chat/completions' not in url else url

    resp = requests.post(
        url,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        json={
            'model': model,
            'messages': messages,
            'temperature': 0.1,
        },
        timeout=90,
    )
    resp.raise_for_status()
    data = resp.json()
    return data['choices'][0]['message']['content']


def _parse_category_id(text, valid_ids):
    text = text.strip()
    m = re.search(r'\{[^{}]*\}', text, re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group())
            cid = obj.get('category_id') or obj.get('id')
            if cid is not None and int(cid) in valid_ids:
                return int(cid)
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
    for vid in valid_ids:
        if str(vid) in text:
            return vid
    return None


def classify_slide_with_llm(db, slide, catalog, api_key, provider='zhipu',
                            model=None, base_url=None):
    """
  对单页调用大模型。返回 (category_id, confidence) 或 (None, 0)。
    """
    valid_ids = {c['id'] for c in catalog}
    labels = '\n'.join(f"- id={c['id']}: {c['label']}" for c in catalog)

    title = (slide['title'] or '')[:80]
    body = (slide['text_content'] or '')[:1200]
    if not body.strip() and not title.strip():
        return None, 0.0

    # Domain context — configurable via settings, defaults to HR consulting
    domain = (db.get_setting('classify_domain', '') or '').strip()
    if not domain:
        domain = '人力资源管理咨询'

    prompt = (
        f"你是{domain}领域的PPT素材分类助手。\n"
        f"请根据页面标题和正文，从下列类别中选择最贴切的一项；若无合适类别则返回 category_id 为 null。\n"
        f"\n"
        f"可选类别：\n"
        f"{labels}\n"
        f"\n"
        f"页面标题：{title}\n"
        f"页面正文：\n"
        f"{body}\n"
        f'\n'
        f'只输出一行 JSON，不要其他说明。格式示例：{{"category_id": 12, "confidence": 0.85}}\n'
        f'若无法判断：{{"category_id": null, "confidence": 0}}'
    )

    model = model or db.get_setting('model_name', '') or DEFAULT_MODEL

    if provider == 'openai':
        url = base_url or 'https://api.openai.com/v1'
        content = _call_openai_compatible(api_key, [{'role': 'user', 'content': prompt}],
                                          model=model or 'gpt-4o-mini', base_url=url)
    else:
        content = _call_openai_compatible(api_key, [{'role': 'user', 'content': prompt}],
                                          model=model, base_url=base_url)

    cid = _parse_category_id(content, valid_ids)
    if cid is None:
        return None, 0.0

    conf = 0.85
    m = re.search(r'"confidence"\s*:\s*([\d.]+)', content)
    if m:
        try:
            conf = min(1.0, max(0.0, float(m.group(1))))
        except ValueError:
            pass
    return cid, conf


def batch_llm_classify(db, slides, progress_callback=None):
    """
  批量 LLM 归类。跳过 source=manual 的页。单页失败不终止整个批次。
  返回 (success_count, error_count, error_messages)
    """
    api_key = (db.get_setting('api_key', '') or '').strip()
    if not api_key:
        return 0, 0, ['请先在设置中填写 API Key']

    provider = db.get_setting('llm_provider', 'zhipu')
    model = db.get_setting('model_name', '') or None
    base_url = db.get_setting('api_base_url', '') or None
    if provider == 'zhipu' and not model:
        model = DEFAULT_MODEL

    catalog = _build_category_catalog(db)
    if not catalog:
        return 0, 0, ['没有可用类别，请先在类别管理中添加']

    ok = 0
    errors = 0
    error_msgs = []
    total = len(slides)
    for i, slide in enumerate(slides):
        sc = db.get_slide_category(slide['id'])
        if sc and sc['source'] == 'manual':
            continue
        if progress_callback:
            progress_callback(f"智能归类 ({i + 1}/{total}): "
                              f"{slide['file_name'] or ''} 第{slide['slide_number']}页")
        try:
            cid, conf = classify_slide_with_llm(
                db, slide, catalog, api_key, provider=provider,
                model=model, base_url=base_url or None)
            if cid:
                db.set_slide_category(slide['id'], cid, conf, 'llm')
                ok += 1
        except requests.RequestException as e:
            errors += 1
            msg = f'API 请求失败 ({slide["file_name"]} 第{slide["slide_number"]}页): {e}'
            error_msgs.append(msg)
            _log.warning(msg)
            # Don't abort — continue to next slide
        except Exception as e:
            errors += 1
            msg = f'归类异常 ({slide["file_name"]} 第{slide["slide_number"]}页): {e}'
            error_msgs.append(msg)
            _log.warning(msg)
            # Don't abort — continue to next slide
    return ok, errors, error_msgs[:5]  # cap error messages at 5
