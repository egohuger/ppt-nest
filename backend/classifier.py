# 关键词幻灯片分类（含路径/标题加权与互斥词）

import json
import re
import logging
from collections import defaultdict

from logger import get_logger

_log = get_logger(__name__)

# 默认互斥规则（命中则对目标类别扣分，避免薪酬/绩效/培训等常见误分）
# 可在设置中通过 classify_negative_rules 键覆盖
DEFAULT_NEGATIVE_RULES = [
    {"triggers": ["培训", "课程", "学习地图", "内训"],
     "blocked": ["薪酬管理", "绩效管理", "岗位管理"]},
    {"triggers": ["招聘", "面试", "录用"],
     "blocked": ["薪酬管理", "绩效管理", "培训发展"]},
    {"triggers": ["党建", "纪委", "巡察"],
     "blocked": ["薪酬管理", "岗位管理", "绩效管理", "人才管理"]},
    {"triggers": ["资产负债表", "利润表", "现金流"],
     "blocked": ["组织管理", "岗位管理", "薪酬管理", "绩效管理"]},
]


def _parse_negative_rules(raw):
    """Parse negative rules from DB setting (JSON) or return defaults."""
    if not raw or not raw.strip():
        return DEFAULT_NEGATIVE_RULES
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and len(parsed) > 0:
            # Validate structure
            for item in parsed:
                if not isinstance(item, dict):
                    raise ValueError("Invalid rule item")
                if 'triggers' not in item or 'blocked' not in item:
                    raise ValueError("Rule missing triggers or blocked")
            return parsed
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        _log.warning("Invalid negative rules in DB, using defaults: %s", e)
    return DEFAULT_NEGATIVE_RULES


class KeywordClassifier:
    """Classify slides into categories based on keyword matching."""

    def __init__(self, db):
        self.db = db
        self.categories = []
        self.name_by_id = {}
        self._negative_rules = DEFAULT_NEGATIVE_RULES
        self.reload()

    def reload(self):
        self.categories = []
        self.name_by_id = {}
        for cat in self.db.get_all_categories():
            kw = json.loads(cat['keywords']) if cat['keywords'] else []
            self.categories.append({
                'id': cat['id'],
                'name': cat['name'],
                'parent_id': cat['parent_id'],
                'keywords': kw,
            })
            self.name_by_id[cat['id']] = cat['name']

        # Load negative rules from DB (if available), fall back to defaults
        raw_rules = self.db.get_setting('classify_negative_rules', '')
        self._negative_rules = _parse_negative_rules(raw_rules)

    def _min_confidence(self):
        try:
            return float(self.db.get_setting('classify_min_confidence', '0.22'))
        except (TypeError, ValueError):
            return 0.22

    def _path_hint_text(self, file_path):
        if not file_path:
            return ''
        parts = []
        for segment in re.split(r'[\\/]', file_path):
            segment = segment.strip()
            if not segment or segment.lower().endswith(('.ppt', '.pptx')):
                continue
            parts.append(segment)
        return ' '.join(parts[-4:]).lower()

    def _score_text(self, text_lower, weight=1.0):
        scores = defaultdict(float)
        for cat in self.categories:
            for kw in cat['keywords']:
                if len(kw) < 2:
                    continue
                kw_lower = kw.lower()
                count = text_lower.count(kw_lower)
                if count > 0:
                    bonus = 1.5 if len(kw_lower) >= 4 else 1.0
                    scores[cat['id']] += count * (len(kw_lower) / 2.0) * bonus * weight
        return scores

    def _apply_negatives_for_text(self, text_lower, scores):
        for rule in self._negative_rules:
            triggers = rule.get('triggers', [])
            blocked_names = rule.get('blocked', [])
            if any(t in text_lower for t in triggers):
                for cat in self.categories:
                    if cat['name'] in blocked_names:
                        scores[cat['id']] *= 0.15
        return scores

    def classify_slide(self, text_content, title='', file_path=''):
        """
        返回 (category_id, confidence)；低于阈值时返回 (None, confidence)。
        """
        min_conf = self._min_confidence()
        body = (text_content or '').strip()
        title_s = (title or '').strip()

        if not body and not title_s:
            return None, 0.0

        text_lower = body.lower()
        scores = self._score_text(text_lower, weight=1.0)

        if title_s:
            title_lower = title_s.lower()
            title_scores = self._score_text(title_lower, weight=2.0)
            for cid, sc in title_scores.items():
                scores[cid] += sc

        path_hint = self._path_hint_text(file_path)
        if path_hint:
            path_scores = self._score_text(path_hint, weight=0.6)
            for cid, sc in path_scores.items():
                scores[cid] += sc

        combined = (text_lower + ' ' + title_s.lower() + ' ' + path_hint).strip()
        scores = self._apply_negatives_for_text(combined, scores)

        if not scores:
            return None, 0.0

        best_id = max(scores, key=scores.get)
        best_score = scores[best_id]

        # N-level cascade: keep descending while a child has enough relative score
        while True:
            children = [c for c in self.categories if c['parent_id'] == best_id]
            if not children:
                break
            children_scores = {c['id']: scores.get(c['id'], 0) for c in children}
            if not children_scores:
                break
            best_child = max(children_scores, key=children_scores.get)
            if children_scores[best_child] >= best_score * 0.35:
                best_id = best_child
                best_score = children_scores[best_child]
            else:
                break

        text_len = max(len(body), len(title_s), 1)
        max_possible = max(text_len / 8.0, 1.0)
        confidence = min(best_score / max_possible, 1.0)

        if confidence < min_conf:
            return None, confidence

        return best_id, confidence

    def classify_slides(self, slides):
        results = []
        for s in slides:
            cid, conf = self.classify_slide(
                s.get('text_content', ''),
                title=s.get('title', ''),
                file_path=s.get('file_path', ''),
            )
            results.append((s, cid, conf))
        return results
