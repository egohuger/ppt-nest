"""手动组页 → 导出 PPTX（多源）。

策略（按源文件聚合）：
  1. 单源：所有页来自同一个 PPT → 复制源文件，删掉没选的页，重排 sldIdLst。
     这条路保真 100%（母版/主题/背景/SmartArt 全都还在）。
  2. 多源：以贡献页数最多的源文件为 base（同 1 处理），其余源的页克隆插入。
     克隆时补三件事，否则必坏：
       - 幻灯片自己的背景（p:bg 在 cSld 下，不在 shapes 里）
       - 占位符继承的 off/ext 显式化（不显式化会全挤到左上角）
       - 图片等 part 的 rId 重映射
     页面尺寸与 base 不同时，把克隆内容包进一个组再等比缩放居中（逐形状缩放会把文字挤爆）。
  3. 含图表 / SmartArt / OLE 的页克隆会坏 → 降级为整页缩略图，并在备注里写来源。
"""

import copy
import os
from io import BytesIO

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.opc.packuri import PackURI
from pptx.util import Emu

from config import get_thumbnail_dir
from logger import get_logger

_log = get_logger(__name__)

P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

# 这些 part 克隆过去会断引用，宁可降级成图片页
RISKY_RELTYPES = {
    'chart': '图表',
    'diagramData': 'SmartArt',
    'diagramLayout': 'SmartArt',
    'diagramQuickStyle': 'SmartArt',
    'diagramColors': 'SmartArt',
    'oleObject': '嵌入式对象',
    'package': '嵌入文件',
    'media': '音视频',
}


class ComposeError(Exception):
    pass


# ─── 小工具 ──────────────────────────────────────────────────────────

def _slug(text, fallback='组稿'):
    text = (text or '').strip() or fallback
    bad = '\\/:*?"<>|\r\n\t'
    return ''.join('_' if c in bad else c for c in text)[:60]


def default_filename(name, ext='.pptx'):
    import datetime
    stamp = datetime.datetime.now().strftime('%Y%m%d')
    return f'{_slug(name)}-{stamp}{ext}'


def _thumb_abs(rel_or_abs):
    if not rel_or_abs:
        return None
    if os.path.isabs(rel_or_abs):
        return rel_or_abs if os.path.exists(rel_or_abs) else None
    p = os.path.join(get_thumbnail_dir(), rel_or_abs.replace('\\', '/'))
    return p if os.path.exists(p) else None


def _risky_kinds(slide):
    kinds = set()
    for rel in slide.part.rels.values():
        name = rel.reltype.rsplit('/', 1)[-1]
        if name in RISKY_RELTYPES:
            kinds.add(RISKY_RELTYPES[name])
    return kinds


def _sldid_rid(el):
    return el.get(f'{{{R_NS}}}id')


# ─── 克隆 ────────────────────────────────────────────────────────────

def _map_rels(src_slide, dst_slide):
    """把源页依赖的图片挂到目标页，返回 {旧 rId: 新 rId}。

    必须走 get_or_add_image_part 重新登记图片 part：
    直接 relate_to 会把源包里的 part 原名（ppt/media/image3.png）搬进目标包，
    与 base 里同名不同内容的图片撞名，zip 里出现重复条目，PowerPoint 会读错图。
    """
    id_map = {}
    for rid, rel in src_slide.part.rels.items():
        if rel.is_external:
            continue
        if rel.reltype == RT.IMAGE:
            try:
                blob = rel.target_part.blob
                _part, new_rid = dst_slide.part.get_or_add_image_part(BytesIO(blob))
                id_map[rid] = new_rid
            except Exception as e:      # 图片损坏时不要整页报废
                _log.warning('组稿：图片 part 挂载失败 %s (%s)', rid, e)
    return id_map


def _copy_background(src_slide, dst_slide, id_map):
    bg = src_slide._element.find(f'{{{P_NS}}}cSld/{{{P_NS}}}bg')
    if bg is None:
        return False
    bg2 = copy.deepcopy(bg)
    for node in bg2.iter():
        for attr in (f'{{{R_NS}}}embed', f'{{{R_NS}}}link'):
            old = node.get(attr)
            if old and old in id_map:
                node.set(attr, id_map[old])
    csld = dst_slide._element.find(f'{{{P_NS}}}cSld')
    csld.insert(0, bg2)
    return True


def _materialize_xfrm(slide):
    """占位符的 off/ext 是从 layout 继承的，克隆到别的 deck 后会丢。
    先按 python-pptx 解析出的值写成显式 xfrm。"""
    for shp in slide.shapes:
        try:
            if shp.left is None:
                continue
            if shp._element.find(f'.//{{{A_NS}}}xfrm') is None:
                shp.left, shp.top, shp.width, shp.height = shp.left, shp.top, shp.width, shp.height
        except Exception as e:
            _log.warning('组稿：占位符尺寸显式化失败 %s (%s)', getattr(shp, 'name', '?'), e)


def _remap_ids(el, id_map):
    for node in el.iter():
        for attr in (f'{{{R_NS}}}embed', f'{{{R_NS}}}link', f'{{{R_NS}}}id'):
            old = node.get(attr)
            if old and old in id_map:
                node.set(attr, id_map[old])
    return el


def _new_group(sp_tree, off, ext, ch_off, ch_ext):
    """建一个 p:grpSp，用于整页等比缩放（文字跟着组缩放，不会溢出）。"""
    ids = [int(e.get('id')) for e in sp_tree.iter(qn('p:cNvPr')) if e.get('id')]
    grp = etree.SubElement(sp_tree, qn('p:grpSp'))
    nv = etree.SubElement(grp, qn('p:nvGrpSpPr'))
    cnv = etree.SubElement(nv, qn('p:cNvPr'))
    cnv.set('id', str(max(ids + [1]) + 1))
    cnv.set('name', '组稿页面')
    etree.SubElement(nv, qn('p:cNvGrpSpPr'))
    etree.SubElement(nv, qn('p:nvPr'))
    gsp = etree.SubElement(grp, qn('p:grpSpPr'))
    xfrm = etree.SubElement(gsp, qn('a:xfrm'))
    o = etree.SubElement(xfrm, qn('a:off')); o.set('x', str(off[0])); o.set('y', str(off[1]))
    e = etree.SubElement(xfrm, qn('a:ext')); e.set('cx', str(ext[0])); e.set('cy', str(ext[1]))
    co = etree.SubElement(xfrm, qn('a:chOff')); co.set('x', str(ch_off[0])); co.set('y', str(ch_off[1]))
    ce = etree.SubElement(xfrm, qn('a:chExt')); ce.set('cx', str(ch_ext[0])); ce.set('cy', str(ch_ext[1]))
    return grp


def _strip_placeholders(slide):
    """去掉克隆形状的占位符标记（p:ph），并重排形状 id。

    位置/尺寸已经显式写死了，占位符身份没有用处；留着反而会让渲染器去目标版式里
    找同名占位符（找不到就把标题按奇怪的方向/字号画出来，实测整句中文顺序被反转）。
    """
    sp_tree = slide.shapes._spTree
    for ph in list(sp_tree.iter(f'{{{P_NS}}}ph')):
        ph.getparent().remove(ph)
    for i, cnv in enumerate(sp_tree.iter(f'{{{P_NS}}}cNvPr'), start=2):
        cnv.set('id', str(i))


def _blank_layout(prs):
    """挑一个没有占位符的版式（源 deck 的版式数量不一定是 python-pptx 默认的 11 个）。"""
    layouts = list(prs.slide_layouts)
    for lay in layouts:
        try:
            if len(lay.placeholders) == 0:
                return lay
        except Exception:
            continue
    return layouts[-1]


def _fix_partname(dst_prs, slide):
    """python-pptx 的 add_slide 在删过页的 deck 上会算出重复 partname
    （zip 里出现两个 ppt/slides/slide4.xml，PowerPoint 会读错页），这里兜一层改名。"""
    names = [str(p.partname) for p in dst_prs.part.package.iter_parts()]
    cur = str(slide.part.partname)
    if names.count(cur) <= 1:
        return
    n = 1
    while f'/ppt/slides/slide{n}.xml' in names:
        n += 1
    slide.part.partname = PackURI(f'/ppt/slides/slide{n}.xml')


def _clone_slide(src_slide, src_prs, dst_prs):
    """把一个源页克隆成 dst_prs 里的新页（返回到新页对象）。"""
    dst = dst_prs.slides.add_slide(_blank_layout(dst_prs))
    _fix_partname(dst_prs, dst)
    for shp in list(dst.shapes):
        shp._element.getparent().remove(shp._element)

    id_map = _map_rels(src_slide, dst)
    _copy_background(src_slide, dst, id_map)
    _materialize_xfrm(src_slide)

    sw, sh = int(src_prs.slide_width), int(src_prs.slide_height)
    W, H = int(dst_prs.slide_width), int(dst_prs.slide_height)
    sp_tree = dst.shapes._spTree

    if (sw, sh) == (W, H):
        for shp in src_slide.shapes:
            sp_tree.append(_remap_ids(copy.deepcopy(shp._element), id_map))
    else:
        scale = min(W / sw, H / sh)
        bw, bh = int(sw * scale), int(sh * scale)
        grp = _new_group(sp_tree, ((W - bw) // 2, (H - bh) // 2), (bw, bh), (0, 0), (sw, sh))
        for shp in src_slide.shapes:
            grp.append(_remap_ids(copy.deepcopy(shp._element), id_map))

    _strip_placeholders(dst)
    _copy_notes(src_slide, dst)
    return dst


def _copy_notes(src_slide, dst_slide):
    """把源页备注整段搬过来。

    python-pptx 没有克隆 notesSlide 部件的接口，这里按段落深拷贝 XML：
    段内换行（a:br）、run 级粗斜体/字号、项目符号层级都跟着走，
    比按 run 重建更保真（重建会把 a:br 丢掉，'A⏎B' 变成 'AB'）。
    """
    try:
        src_tf = src_slide.notes_slide.notes_text_frame
    except Exception:
        return
    if src_tf is None:
        return
    paragraphs = list(src_tf.paragraphs)
    if not any((p.text or '').strip() for p in paragraphs):
        return
    try:
        dst_tf = dst_slide.notes_slide.notes_text_frame
        dst_tf.clear()
        for i, p in enumerate(paragraphs):
            target = dst_tf.paragraphs[0] if i == 0 else dst_tf.add_paragraph()
            src_ppr = p._p.find(qn('a:pPr'))
            if src_ppr is not None:
                old_ppr = target._p.find(qn('a:pPr'))
                if old_ppr is not None:
                    target._p.remove(old_ppr)
                target._p.insert(0, copy.deepcopy(src_ppr))
            for child in list(p._p):
                if child.tag == qn('a:pPr'):
                    continue
                target._p.append(copy.deepcopy(child))
    except Exception as e:
        _log.warning('组稿：复制备注失败 (%s)', e)


def _add_image_slide(dst_prs, thumb_abs, caption):
    """兜底页：整页缩略图铺满，来源只写进备注（不出现在画面上）。"""
    dst = dst_prs.slides.add_slide(_blank_layout(dst_prs))
    _fix_partname(dst_prs, dst)
    for shp in list(dst.shapes):
        shp._element.getparent().remove(shp._element)
    if thumb_abs:
        dst.shapes.add_picture(thumb_abs, 0, 0,
                               width=dst_prs.slide_width, height=dst_prs.slide_height)
    if caption:
        try:
            dst.notes_slide.notes_text_frame.text = caption
        except Exception:
            pass
    return dst


# ─── 主流程 ──────────────────────────────────────────────────────────

def _iter_shape_tree(shapes):
    """递归展开组合形状，按顺序产出每个 shape。"""
    for shp in shapes:
        yield shp
        if getattr(shp, 'shape_type', None) is not None and hasattr(shp, 'shapes'):
            try:
                yield from _iter_shape_tree(shp.shapes)
            except Exception:
                pass


def _replace_in_paragraph(para, rules, stats):
    """先按 run 替换；跨 run 拆字时退化为整段重写（会丢掉该段的分段格式）。"""
    for rule in rules:
        src, dst = rule['from'], rule['to']
        if not src:
            continue
        # 1) 常规：runs 里各自替换（保留格式）
        hit = False
        for run in para.runs:
            if src in run.text:
                run.text = run.text.replace(src, dst)
                stats['replaced'] += 1
                hit = True
        if hit:
            continue
        # 2) 跨 run 拆字：整段拼起来还含目标词 → 合到第一个 run
        full = ''.join(r.text for r in para.runs)
        if src in full and para.runs:
            para.runs[0].text = full.replace(src, dst)
            for r in para.runs[1:]:
                r.text = ''
            stats['replaced'] += 1
            stats['merged_runs'] += 1


def _apply_replacements(prs, rules, with_notes=True):
    """成套改字：正文 / 表格 / 组合形状 / 备注。

    图表与 SmartArt 里的文字改不了 —— 单独数出来告诉用户，不假装成功。
    """
    stats = {'replaced': 0, 'merged_runs': 0, 'notes_replaced': 0, 'chart_skipped': 0}
    needles = [r['from'].encode('utf-8') for r in (rules or []) if r['from']]

    for slide in prs.slides:
        for shp in _iter_shape_tree(slide.shapes):
            if getattr(shp, 'has_chart', False):
                try:
                    blob = shp.chart.part.blob
                    if any(n in blob for n in needles):
                        stats['chart_skipped'] += 1
                except Exception:
                    pass
                continue
            if getattr(shp, 'has_text_frame', False):
                for para in shp.text_frame.paragraphs:
                    _replace_in_paragraph(para, rules, stats)
            if getattr(shp, 'has_table', False):
                try:
                    for row in shp.table.rows:
                        for cell in row.cells:
                            for para in cell.text_frame.paragraphs:
                                _replace_in_paragraph(para, rules, stats)
                except Exception:
                    pass
        if with_notes:
            try:
                tf = slide.notes_slide.notes_text_frame
                for para in tf.paragraphs:
                    before = stats['replaced']
                    _replace_in_paragraph(para, rules, stats)
                    if stats['replaced'] > before:
                        stats['notes_replaced'] += 1
            except Exception:
                pass
    return stats


def export_composition(items, output_path, progress=None, replacements=None):
    """items: [{slide_id, file_path, slide_number, title, file_name, thumbnail_path}] 按顺序。

    返回 {output, total, native, cloned, image, missing, notes:[...]}
    """
    if not items:
        raise ComposeError('组稿里还没有页面')

    total = len(items)
    stats = {'output': output_path, 'total': total,
             'native': 0, 'cloned': 0, 'image': 0, 'missing': 0, 'notes': []}

    def tick(done, label):
        if progress:
            progress(done, total, label)

    # 按源文件分组，页数最多的那本当 base
    groups = {}
    for it in items:
        groups.setdefault(it['file_path'], []).append(it)
    base_path = max(groups, key=lambda p: len(groups[p]))

    prs = None
    src_cache = {}
    base_numbers = {}
    if base_path and os.path.exists(base_path) and base_path.lower().endswith('.pptx'):
        try:
            prs = Presentation(base_path)
            src_cache[base_path] = prs
            for i, el in enumerate(list(prs.slides._sldIdLst), start=1):
                base_numbers[i] = el
        except Exception as e:
            _log.warning('组稿：base 打不开 %s (%s)，全部走图片/克隆', base_path, e)
            prs = None
    if prs is None:
        prs = Presentation()
        prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)

    # base 里没被选中的页先删掉
    if base_numbers:
        keep = {it['slide_number'] for it in groups.get(base_path, [])}
        for num in list(base_numbers):
            if num not in keep:
                el = base_numbers.pop(num)
                try:
                    prs.part.drop_rel(_sldid_rid(el))
                except Exception:
                    pass
                prs.slides._sldIdLst.remove(el)
        # 只剩 base 的页时，顺序稍后统一重排
        if len(groups) == 1:
            stats['native'] = len(keep)

    ordered_els = []
    used_base = set()
    done = 0

    for it in items:
        done += 1
        label = f"第 {done}/{total} 页 · {it.get('title') or it.get('file_name') or ''}"
        is_base_slot = (it['file_path'] == base_path
                        and it['slide_number'] in base_numbers
                        and it['slide_number'] not in used_base)
        if is_base_slot:
            used_base.add(it['slide_number'])
            ordered_els.append(base_numbers[it['slide_number']])
            if len(groups) > 1:
                stats['native'] += 1
            tick(done, label)
            continue

        # 需要从别的源文件搬过来
        src_slide = None
        src_prs = None
        path = it['file_path']
        if path in src_cache:
            src_prs = src_cache[path]
        elif path and os.path.exists(path) and path.lower().endswith('.pptx'):
            try:
                src_prs = Presentation(path)
                src_cache[path] = src_prs
            except Exception as e:
                _log.warning('组稿：源文件打不开 %s (%s)', path, e)
                src_prs = None
        elif path and os.path.exists(path):
            stats['notes'].append(f"{it.get('file_name')} 是旧版 .ppt，无法克隆，已用缩略图占位")

        if src_prs is not None and 1 <= it['slide_number'] <= len(src_prs.slides):
            src_slide = src_prs.slides[it['slide_number'] - 1]

        risky = _risky_kinds(src_slide) if src_slide is not None else {'源文件缺失'}
        thumb = _thumb_abs(it.get('thumbnail_path'))
        caption = f"来源：{it.get('file_name', '')} 第 {it['slide_number']} 页"
        if risky:
            caption += f"（含{'、'.join(sorted(risky))}，无法克隆，已转为整页图）"
        elif src_slide is None:
            caption += "（源文件缺失，已转为整页图）"

        if src_slide is not None and not risky:
            try:
                _clone_slide(src_slide, src_prs, prs)
                ordered_els.append(prs.slides._sldIdLst[-1])
                stats['cloned'] += 1
                tick(done, label)
                continue
            except Exception as e:
                _log.warning('组稿：克隆失败 %s 第%s页 (%s)', path, it['slide_number'], e)
                caption += f"（克隆失败：{type(e).__name__}）"

        if thumb:
            _add_image_slide(prs, thumb, caption)
            ordered_els.append(prs.slides._sldIdLst[-1])
            stats['image'] += 1
        else:
            stats['missing'] += 1
            stats['notes'].append(f"跳过一页：{caption}（没有缩略图）")
        tick(done, label)

    # 统一重排
    lst = prs.slides._sldIdLst
    for el in list(lst):
        lst.remove(el)
    for el in ordered_els:
        lst.append(el)

    # 成套改字（可选）：只在导出的这一份上生效，源 PPT 和素材库都不动
    if replacements:
        try:
            rep_stats = _apply_replacements(prs, replacements)
            stats['replacements'] = rep_stats
            if rep_stats['chart_skipped']:
                stats['notes'].append(
                    f"{rep_stats['chart_skipped']} 处图表里的文字没替换（图表文字不在可编辑范围内，需要回源文件改）")
        except Exception as e:
            _log.warning('组稿：成套替换失败 (%s)', e)
            stats['notes'].append(f'成套替换执行失败：{e}')

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    prs.save(output_path)

    stats['slides'] = len(prs.slides._sldIdLst)
    _log.info('组稿导出完成：%s（原生 %s / 克隆 %s / 图片 %s）',
              output_path, stats['native'], stats['cloned'], stats['image'])
    return stats
