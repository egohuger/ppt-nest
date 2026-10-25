#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成内置示例 PPT（首次引导用 + 本机速度标定样本）。

风格：16:9、深蓝商务、纯文字/形状/表格/一张原生图表，控制在 1MB 以内。
内容为脱敏后的通用管理咨询场景（集团组织与人力资源体系），不含任何客户信息。
"""
import os
import sys
from lxml import etree
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.oxml.ns import qn

NAVY   = RGBColor(0x1E, 0x3A, 0x5F)
BLUE   = RGBColor(0x3B, 0x82, 0xF6)
LIGHT  = RGBColor(0xEF, 0xF4, 0xFB)
GREY   = RGBColor(0x64, 0x74, 0x8B)
DARK   = RGBColor(0x22, 0x2B, 0x38)
WHITE  = RGBColor(0xFF, 0xFF, 0xFF)
ACCENT = RGBColor(0xF5, 0x9E, 0x0B)
LINE   = RGBColor(0xD5, 0xDE, 0xEB)

FONT = '微软雅黑'
W, H = 13.333, 7.5


def set_font(run, size=None, bold=None, color=None, font=FONT):
    f = run.font
    if size is not None:
        f.size = Pt(size)
    if bold is not None:
        f.bold = bold
    if color is not None:
        f.color.rgb = color
    f.name = font
    rPr = run._r.get_or_add_rPr()
    for tag in ('a:ea', 'a:cs'):
        el = rPr.find(qn(tag))
        if el is None:
            el = etree.SubElement(rPr, qn(tag))
        el.set('typeface', font)


def textbox(slide, left, top, width, height, text, size=16, bold=False,
            color=DARK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP,
            line_spacing=1.25, space_after=4):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        p.space_after = Pt(space_after)
        r = p.add_run()
        r.text = ln
        set_font(r, size, bold, color)
    return box


def _kill_shadow(sp):
    """去掉形状阴影。

    python-pptx 的 shadow.inherit=False 只是不继承主题，形状仍带着
    <p:style> 里的 effectRef，PowerPoint / LibreOffice 会照旧画阴影。
    必须把整个 p:style 引用摘掉，再显式给一个空 effectLst。
    """
    el = sp._element
    style = el.find(qn('p:style'))
    if style is not None:
        el.remove(style)
    spPr = el.spPr
    for e in spPr.findall(qn('a:effectLst')):
        spPr.remove(e)
    etree.SubElement(spPr, qn('a:effectLst'))


def rect(slide, left, top, width, height, fill=None, line=None, shape=MSO_SHAPE.RECTANGLE,
         line_w=1.0, radius=None):
    sp = slide.shapes.add_shape(shape, Inches(left), Inches(top), Inches(width), Inches(height))
    if fill is None:
        sp.fill.background()
    else:
        sp.fill.solid()
        sp.fill.fore_color.rgb = fill
    if line is None:
        sp.line.fill.background()
    else:
        sp.line.color.rgb = line
        sp.line.width = Pt(line_w)
    sp.shadow.inherit = False
    _kill_shadow(sp)
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        sp.adjustments[0] = radius
    if sp.has_text_frame:
        sp.text_frame.word_wrap = True
    return sp


def shape_text(sp, text, size=14, bold=False, color=WHITE, align=PP_ALIGN.CENTER,
               anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.15):
    tf = sp.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.08)
    tf.margin_top = tf.margin_bottom = Inches(0.04)
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        r = p.add_run()
        r.text = ln
        set_font(r, size, bold, color)


def blank(prs, with_title=False):
    """with_title=True 用 Title Only 版式。

    软件解析时优先读 slide.shapes.title（占位符），没有占位符才会退回
    「页面上第一段文字」——那样会把页眉的章节名当成标题，所以标题必须走占位符。
    """
    return prs.slides.add_slide(prs.slide_layouts[5 if with_title else 6])


def header(slide, section, page):
    """统一页眉页脚：左上细线 + 章节名，底部页码。"""
    rect(slide, 0.9, 0.52, 0.09, 0.26, fill=BLUE)
    textbox(slide, 1.1, 0.48, 7.0, 0.34, section, size=12, color=GREY)
    rect(slide, 0.9, 7.02, W - 1.8, 0.012, fill=LINE)
    textbox(slide, 0.9, 7.08, 6.0, 0.3, '组织与人力资源体系优化方案 · 示例素材', size=9.5, color=GREY)
    textbox(slide, W - 1.9, 7.08, 1.0, 0.3, str(page), size=9.5, color=GREY, align=PP_ALIGN.RIGHT)


def title(slide, text, sub=None):
    ph = slide.shapes.title
    if ph is not None:
        ph.left, ph.top, ph.width, ph.height = Inches(0.9), Inches(0.95), Inches(W - 1.8), Inches(0.68)
        tf = ph.text_frame
        tf.clear()
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = Inches(0)
        tf.margin_top = tf.margin_bottom = Inches(0)
        tf.vertical_anchor = MSO_ANCHOR.TOP
        try:
            from pptx.enum.text import MSO_AUTO_SIZE
            tf.auto_size = MSO_AUTO_SIZE.NONE
        except Exception:
            pass
        p0 = tf.paragraphs[0]
        p0.alignment = PP_ALIGN.LEFT
        r0 = p0.add_run()
        r0.text = text
        set_font(r0, 30, True, NAVY)
    else:
        textbox(slide, 0.9, 0.95, W - 1.8, 0.7, text, size=30, bold=True, color=NAVY)
    if sub:
        textbox(slide, 0.9, 1.66, W - 1.8, 0.4, sub, size=13.5, color=GREY)
        rect(slide, 0.92, 2.12, 0.55, 0.05, fill=ACCENT)


def section_slide(prs, num, name, desc, page):
    s = blank(prs)
    rect(s, 0, 0, W, H, fill=NAVY)
    rect(s, 0.9, 2.55, 0.06, 1.9, fill=ACCENT)
    # 编号 + 章节名放同一个文本框：软件取标题时优先读第一段文字，
    # 分成两个框会只拿到编号「01」。
    tb = s.shapes.add_textbox(Inches(1.15), Inches(2.32), Inches(8.2), Inches(1.75))
    tf = tb.text_frame
    tf.word_wrap = True
    pa = tf.paragraphs[0]
    pa.alignment = PP_ALIGN.LEFT
    ra = pa.add_run(); ra.text = num
    set_font(ra, 54, True, RGBColor(0x5B, 0x7F, 0xAE))
    pb = tf.add_paragraph()
    pb.alignment = PP_ALIGN.LEFT
    rb = pb.add_run(); rb.text = name
    set_font(rb, 34, True, WHITE)
    textbox(s, 1.22, 4.16, 8.4, 0.5, desc, size=14, color=RGBColor(0xB6, 0xC6, 0xDA))
    textbox(s, W - 1.9, 7.08, 1.0, 0.3, str(page), size=9.5,
            color=RGBColor(0x8A, 0x9E, 0xB8), align=PP_ALIGN.RIGHT)
    return s


def table(slide, left, top, width, data, col_widths=None, head_fill=NAVY,
          row_h=0.42, head_h=0.46, size=11.5, zebra=True, align_center=None):
    rows, cols = len(data), len(data[0])
    shp = slide.shapes.add_table(rows, cols, Inches(left), Inches(top),
                                 Inches(width), Inches(head_h + row_h * (rows - 1)))
    tbl = shp.table
    tbl.first_row = True
    if col_widths:
        for i, wd in enumerate(col_widths):
            tbl.columns[i].width = Inches(wd)
    tbl.rows[0].height = Inches(head_h)
    for r in range(1, rows):
        tbl.rows[r].height = Inches(row_h)

    for c in range(cols):
        cell = tbl.cell(0, c)
        cell.fill.solid()
        cell.fill.fore_color.rgb = head_fill
        cell.margin_left = cell.margin_right = Inches(0.08)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cell.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER if (align_center is None or align_center[c]) else PP_ALIGN.LEFT
        r0 = p.add_run()
        r0.text = str(data[0][c])
        set_font(r0, size, True, WHITE)

    for r in range(1, rows):
        for c in range(cols):
            cell = tbl.cell(r, c)
            cell.fill.solid()
            cell.fill.fore_color.rgb = LIGHT if (zebra and r % 2 == 0) else WHITE
            cell.margin_left = cell.margin_right = Inches(0.08)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            p = cell.text_frame.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER if (align_center is None or align_center[c]) else PP_ALIGN.LEFT
            r1 = p.add_run()
            r1.text = str(data[r][c])
            set_font(r1, size, c == 0, DARK if c == 0 else GREY)
    return shp


def build(path):
    prs = Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    page = [0]

    def P():
        page[0] += 1
        return page[0]

    # ── 1 封面 ──
    s = blank(prs); p = P()
    rect(s, 0, 0, W, H, fill=WHITE)
    rect(s, 0, 0, 0.32, H, fill=NAVY)
    rect(s, 0.32, 0, 0.06, H, fill=ACCENT)
    textbox(s, 1.35, 2.62, 10.4, 1.5, '组织与人力资源体系优化方案', size=44, bold=True, color=NAVY)
    textbox(s, 1.35, 2.05, 9.6, 0.5, 'XX 城投集团 · 人力资源咨询项目', size=13.5, color=BLUE, bold=True)
    textbox(s, 1.35, 3.72, 10.4, 0.5, '岗位 · 职级 · 薪酬 · 绩效 一体化设计', size=19, color=GREY)
    rect(s, 1.38, 4.42, 1.5, 0.05, fill=ACCENT)
    textbox(s, 1.35, 4.72, 10.0, 0.9,
            '示例素材：用于首次使用引导与本机速度标定\n可随时删除，不影响软件功能',
            size=11.5, color=RGBColor(0x94, 0xA3, 0xB8), line_spacing=1.5)
    textbox(s, 1.35, 6.55, 8.0, 0.35, '2026 年 · 管理咨询事业部', size=11.5, color=GREY)

    # ── 2 目录 ──
    s = blank(prs, True); p = P(); header(s, '目录', p)
    title(s, '方案总览', '五个部分，从诊断到落地')
    items = [
        ('01', '现状诊断', '组织、岗位、人员、薪酬四个维度的现状与问题'),
        ('02', '组织架构优化', '从职能梳理到目标架构与部门职责界定'),
        ('03', '岗位与职级体系', '岗位序列划分、职级通道与岗位价值评估'),
        ('04', '薪酬与绩效设计', '薪酬结构、外部对标、绩效管理框架'),
        ('05', '实施路径与保障', '三期推进计划、风险预判与配套机制'),
    ]
    y = 2.55
    for num, name, desc in items:
        rect(s, 0.9, y, 0.62, 0.62, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.14)
        sh = s.shapes[-1]; shape_text(sh, num, size=15, bold=True, color=BLUE)
        textbox(s, 1.7, y + 0.02, 3.0, 0.34, name, size=16.5, bold=True, color=NAVY)
        textbox(s, 1.7, y + 0.34, 9.4, 0.3, desc, size=11.5, color=GREY)
        y += 0.82

    # ── 3 章节一 ──
    p = P(); section_slide(prs, '01', '现状诊断', '用统一口径看清组织与人员的真实状态', p)

    # ── 4 诊断方法 ──
    s = blank(prs, True); p = P(); header(s, '01 现状诊断', p)
    title(s, '诊断路径：四步看清底数', '资料研读 → 数据测算 → 访谈验证 → 问题归集')
    steps = [
        ('资料研读', '制度文件、\n组织手册、\n岗位说明书'),
        ('数据测算', '编制与在岗、\n人均效能、\n薪酬分位'),
        ('访谈验证', '高管、中层、\n骨干与一线，\n覆盖 3 个层级'),
        ('问题归集', '按组织 / 岗位 /\n薪酬 / 绩效\n四类归档'),
    ]
    x = 0.95
    for i, (name, desc) in enumerate(steps):
        box = rect(s, x, 2.75, 2.55, 1.72, fill=WHITE, line=LINE, line_w=1.2,
                   shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        shape_text(box, f'0{i+1}  {name}', size=13.5, bold=True, color=NAVY,
                   align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.TOP)
        textbox(s, x + 0.15, 3.28, 2.25, 1.1, desc, size=11, color=GREY,
                align=PP_ALIGN.CENTER, line_spacing=1.4)
        if i < 3:
            arrow = rect(s, x + 2.62, 3.42, 0.42, 0.36, fill=BLUE, shape=MSO_SHAPE.RIGHT_ARROW)
        x += 3.08
    rect(s, 0.95, 4.92, W - 1.9, 0.9, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
    textbox(s, 1.2, 5.08, W - 2.4, 0.66,
            '本次诊断共覆盖 4 个业务板块、18 个部门、236 个岗位，形成 1 份诊断报告与 3 张问题清单。',
            size=12.5, color=NAVY, line_spacing=1.4)

    # ── 5 核心发现 ──
    s = blank(prs, True); p = P(); header(s, '01 现状诊断', p)
    title(s, '五个核心发现', '从组织到激励，问题沿着链条逐层传导')
    findings = [
        ('职能交叉', '3 个部门同时承担资产管理职能，审批链条平均 4.2 个节点'),
        ('层级偏多', '集团到一线最多 6 层，管理跨度均值仅 4.1 人'),
        ('岗位序列缺失', '技术、技能、营销岗位共用管理通道，晋升通道单一'),
        ('薪酬结构失衡', '固定与浮动比例 9:1，绩效差异无法体现'),
        ('考核与战略脱节', '部门指标与三年战略目标对接率不足 40%'),
    ]
    y = 2.42
    for i, (name, desc) in enumerate(findings):
        rect(s, 0.9, y + 0.1, 0.1, 0.5, fill=ACCENT)
        textbox(s, 1.15, y + 0.02, 2.5, 0.4, name, size=14.5, bold=True, color=NAVY)
        textbox(s, 3.75, y + 0.04, W - 4.8, 0.4, desc, size=12, color=GREY)
        y += 0.86

    # ── 6 组织架构现状 ──
    s = blank(prs, True); p = P(); header(s, '01 现状诊断', p)
    title(s, '组织架构现状', '集团—板块—部门三级架构，管控界面尚不清晰')
    CX = W / 2
    hq_w, hq_h, hq_y = 2.75, 0.62, 2.45
    top = rect(s, CX - hq_w / 2, hq_y, hq_w, hq_h, fill=NAVY,
               shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12)
    shape_text(top, '集团总部', size=14, bold=True)

    boards = ['城市建设板块', '资产运营板块', '公共服务板块', '产业投资板块']
    bw, bgap = 2.66, 0.26
    bx0 = 0.95
    by = 3.62
    # 主干：总部 → 横线 → 各板块
    rail_y = 3.34
    rect(s, CX - 0.015, hq_y + hq_h, 0.03, rail_y - (hq_y + hq_h), fill=RGBColor(0xB8, 0xC4, 0xD6))
    centers = [bx0 + i * (bw + bgap) + bw / 2 for i in range(4)]
    rect(s, centers[0], rail_y - 0.015, centers[-1] - centers[0], 0.03, fill=RGBColor(0xB8, 0xC4, 0xD6))
    for cx, b in zip(centers, boards):
        rect(s, cx - 0.015, rail_y, 0.03, by - rail_y, fill=RGBColor(0xB8, 0xC4, 0xD6))
        bx = rect(s, cx - bw / 2, by, bw, 0.6, fill=BLUE,
                  shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12)
        shape_text(bx, b, size=12.5, bold=True)

    # 总部内设部门：单独一条浅底说明带，避免被误读成板块的下级
    rect(s, 0.95, 4.68, W - 1.9, 1.05, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    textbox(s, 1.18, 4.78, 5.0, 0.3, '集团总部内设部门', size=11.5, bold=True, color=BLUE)
    depts = ['综合管理部', '人力资源部', '财务部', '投资发展部', '工程管理部', '审计法务部']
    dx = 1.18
    for d in depts:
        textbox(s, dx, 5.16, 1.8, 0.3, d, size=11, color=NAVY)
        dx += 1.84
    textbox(s, 0.95, 5.95, W - 1.9, 0.9,
            '问题：板块之间职能边界模糊，总部部门对下管控偏运营、缺赋能；同一职能在总部与板块重复设置，'
            '导致决策慢、责任难追溯。', size=12, color=GREY, line_spacing=1.6)

    # ── 7 人员与岗位现状 ──
    s = blank(prs, True); p = P(); header(s, '01 现状诊断', p)
    title(s, '人员与岗位现状', '总量不缺，结构性缺员与冗余并存')
    data = [
        ['板块', '部门数', '编制', '在岗', '缺员', '人均营收(万元)'],
        ['集团总部', '8', '96', '88', '-8', '—'],
        ['城市建设', '5', '620', '586', '-34', '182'],
        ['资产运营', '3', '210', '196', '-14', '264'],
        ['公共服务', '4', '880', '912', '+32', '76'],
        ['产业投资', '2', '64', '58', '-6', '412'],
        ['合计', '22', '1870', '1840', '-30', '—'],
    ]
    table(s, 0.95, 2.5, W - 1.9, data, col_widths=[2.1, 1.35, 1.35, 1.35, 1.35, 2.2],
          align_center=[False, True, True, True, True, True])
    textbox(s, 0.95, 6.02, W - 1.9, 0.8,
            '公共服务板块超编 32 人，一线技能岗缺口 40 余人；总部管理岗与管理幅度不匹配，人均管理跨度偏低。',
            size=12, color=GREY, line_spacing=1.5)

    # ── 8 章节二 ──
    p = P(); section_slide(prs, '02', '组织架构优化', '把该总部管的收上来，把该板块干的放下去', p)

    # ── 9 优化原则 ──
    s = blank(prs, True); p = P(); header(s, '02 组织架构优化', p)
    title(s, '五条优化原则', '先定管控模式，再动架构')
    ps = [('战略导向', '架构服务于三年战略'), ('权责对等', '决策权跟着责任走'),
          ('界面清晰', '一件事只有一个主责'), ('跨度合理', '管理跨度 6—10 人'),
          ('精简高效', '层级压到 4 层以内')]
    x = 0.95
    for i, (name, desc) in enumerate(ps):
        circ = rect(s, x + 0.62, 2.7, 1.15, 1.15, fill=LIGHT, shape=MSO_SHAPE.OVAL)
        shape_text(circ, f'0{i+1}', size=18, bold=True, color=BLUE)
        textbox(s, x, 4.02, 2.4, 0.36, name, size=13.5, bold=True, color=NAVY, align=PP_ALIGN.CENTER)
        textbox(s, x, 4.4, 2.4, 0.4, desc, size=10.5, color=GREY, align=PP_ALIGN.CENTER)
        x += 2.36
    rect(s, 0.95, 5.2, W - 1.9, 1.2, fill=WHITE, line=LINE, line_w=1.1,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    textbox(s, 1.2, 5.36, W - 2.4, 0.9,
            '管控模式建议：集团定位「战略 + 财务 + 人事」管控，板块定位「业务运营中心」，\n'
            '总部负责规则与赋能，板块负责经营结果。',
            size=12, color=NAVY, line_spacing=1.6)

    # ── 10 目标架构 ──
    s = blank(prs, True); p = P(); header(s, '02 组织架构优化', p)
    title(s, '目标组织架构', '三层架构 + 共享服务中心')
    layers = [
        ('集团总部', '战略投资 · 财务管控 · 人力资源 · 审计法务 · 数字化', NAVY, 1.6),
        ('板块公司', '城市建设 · 资产运营 · 公共服务 · 产业投资', BLUE, 3.35),
        ('项目/分公司', '按区域与项目设置，统一由板块管理', GREY, 5.1),
    ]
    for name, desc, color, y in layers:
        box = rect(s, 0.95, y, 3.0, 0.86, fill=color, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        shape_text(box, name, size=14, bold=True)
        textbox(s, 4.15, y + 0.12, 7.8, 0.62, desc, size=11.5, color=GREY, line_spacing=1.4)
    rect(s, 0.95, 6.24, W - 1.9, 0.62, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.1)
    textbox(s, 1.15, 6.34, W - 2.3, 0.44,
            '新增财务共享中心与人力共享中心，承接核算、报销、社保、招聘等事务性工作。',
            size=11.5, color=NAVY)

    # ── 11 职责调整 ──
    s = blank(prs, True); p = P(); header(s, '02 组织架构优化', p)
    title(s, '部门职责调整对照', '同一职能只留一个主责部门')
    data = [
        ['职能事项', '调整前', '调整后'],
        ['资产管理', '资产管理部、财务部、工程部三方共管', '统一由资产管理部主责，财务部只做账务核算'],
        ['招标采购', '总部与板块各自组织', '10 万元以上由总部集中采购，以下板块自行组织'],
        ['人事管理', '总部管中层，板块管全员', '总部定规则与干部，板块负责全员日常管理'],
        ['数据报表', '各部门自行统计、口径不一', '数字化中心统一口径，月度自动出具'],
    ]
    table(s, 0.95, 2.5, W - 1.9, data, col_widths=[2.0, 4.3, 5.15],
          row_h=0.52, align_center=[False, False, False], size=11)

    # ── 12 章节三 ──
    p = P(); section_slide(prs, '03', '岗位与职级体系', '让每个岗位都有清晰的成长通道', p)

    # ── 13 岗位序列 ──
    s = blank(prs, True); p = P(); header(s, '03 岗位与职级体系', p)
    title(s, '岗位序列划分', '五条序列，管理之外还有专业通道')
    data = [
        ['序列', '覆盖岗位', '岗位数', '晋升主通道'],
        ['管理序列', '集团及板块中高层管理岗', '86', 'M1—M5'],
        ['专业序列', '投资、财务、人力、法务、工程', '412', 'P1—P7'],
        ['技术序列', '设计、造价、施工技术、运维', '524', 'T1—T8'],
        ['技能序列', '驾驶、维修、安保、操作工', '736', 'S1—S6'],
        ['营销序列', '招商、销售、客户服务', '82', 'H1—H5'],
    ]
    table(s, 0.95, 2.5, W - 1.9, data, col_widths=[2.0, 5.3, 1.5, 2.65],
          align_center=[False, False, True, True])

    # ── 14 职级通道 ──
    s = blank(prs, True); p = P(); header(s, '03 岗位与职级体系', p)
    title(s, '职级通道设计', '管理与专业并行，横向可转换')
    TOP, BOT = 2.55, 6.1
    mgr = [('M5', '总经理'), ('M4', '副总经理'), ('M3', '部门经理'), ('M2', '副经理'), ('M1', '主管')]
    step = (BOT - TOP) / len(mgr)
    for i, (code, name) in enumerate(mgr):
        y = TOP + i * step
        box = rect(s, 0.95, y + 0.04, 1.35, step - 0.1, fill=NAVY if i < 3 else BLUE,
                   shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12)
        shape_text(box, code, size=13, bold=True)
        textbox(s, 2.45, y + step / 2 - 0.15, 2.0, 0.3, name, size=12, color=DARK)
    textbox(s, 0.95, 2.18, 3.4, 0.3, '管理序列　M1—M5', size=11, bold=True, color=GREY)

    pro = [('P7', '专家'), ('P6', '资深'), ('P5', '高级'), ('P4', '中级'),
           ('P3', '初级'), ('P2', '助理'), ('P1', '见习')]
    step2 = (BOT - TOP) / len(pro)
    for i, (code, name) in enumerate(pro):
        y = TOP + i * step2
        box = rect(s, 5.0, y + 0.04, 1.35, step2 - 0.1, fill=WHITE, line=BLUE, line_w=1.2,
                   shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12)
        shape_text(box, code, size=12, bold=True, color=BLUE)
        textbox(s, 6.5, y + step2 / 2 - 0.15, 1.5, 0.3, name, size=11.5, color=GREY)
    textbox(s, 5.0, 2.18, 3.4, 0.3, '专业序列　P1—P7', size=11, bold=True, color=GREY)

    rect(s, 9.05, TOP, 3.35, BOT - TOP, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    textbox(s, 9.3, TOP + 0.18, 2.9, 0.36, '通道转换规则', size=13, bold=True, color=NAVY)
    textbox(s, 9.3, TOP + 0.68, 2.9, BOT - TOP - 0.85,
            '· 专业序列 P5 及以上，可竞聘管理序列 M2 岗位\n\n'
            '· 管理序列任满 2 年，可平级转专业序列\n\n'
            '· 技术序列 T6 及以上，享受部门副职待遇\n\n'
            '· 跨序列转换需通过岗位价值评估与任职资格认证',
            size=10.5, color=GREY, line_spacing=1.45, space_after=0)

    # ── 15 岗位价值评估 ──
    s = blank(prs, True); p = P(); header(s, '03 岗位与职级体系', p)
    title(s, '岗位价值评估', '七因素法，权重合计 100%')
    data = [
        ['评估因素', '权重', '评估要点'],
        ['责任风险', '25%', '决策影响范围、失误后果、资产与人员责任'],
        ['知识经验', '20%', '学历、专业资质、经验年限'],
        ['管理幅度', '15%', '直接下属数量、跨部门协调复杂度'],
        ['沟通难度', '12%', '对内对外沟通层级与频次'],
        ['解决问题', '12%', '问题的常规性与创新要求'],
        ['工作环境', '8%', '现场作业风险、外勤与驻场比例'],
        ['业绩贡献', '8%', '对营收、成本、效率的直接贡献'],
    ]
    table(s, 0.95, 2.45, W - 1.9, data, col_widths=[2.3, 1.4, 7.75],
          align_center=[False, True, False], row_h=0.44, size=11)

    # ── 16 章节四 ──
    p = P(); section_slide(prs, '04', '薪酬与绩效设计', '把有限的薪酬花在关键岗位上', p)

    # ── 17 薪酬结构 ──
    s = blank(prs, True); p = P(); header(s, '04 薪酬与绩效设计', p)
    title(s, '薪酬结构与固浮比', '不同序列差异化设计')
    data = [
        ['序列', '固定部分', '浮动部分', '浮动占比', '设计要点'],
        ['管理序列', '岗位工资 + 津贴', '年度绩效 + 超额分享', '40%—50%', '与经营结果强挂钩'],
        ['专业序列', '岗位工资 + 能力工资', '季度绩效', '20%—30%', '强调专业能力成长'],
        ['技术序列', '岗位工资 + 技能津贴', '项目奖金', '25%—35%', '按项目难度与交付质量'],
        ['技能序列', '岗位工资 + 计件/工时', '月度绩效', '15%—25%', '多劳多得、稳定队伍'],
        ['营销序列', '底薪', '提成 + 季度奖', '50%—60%', '高浮动、强激励'],
    ]
    table(s, 0.95, 2.5, W - 1.9, data, col_widths=[1.9, 3.0, 2.7, 1.6, 2.7],
          row_h=0.48, size=11, align_center=[False, False, False, True, False])

    # ── 18 薪酬对标（原生图表）──
    s = blank(prs, True); p = P(); header(s, '04 薪酬与绩效设计', p)
    title(s, '薪酬外部对标', '关键岗位目标定位市场 50—75 分位')
    chart_data = CategoryChartData()
    chart_data.categories = ['部门经理', '高级工程师', '资深专员', '技能骨干', '营销主管']
    chart_data.add_series('本司当前', (18.6, 22.4, 16.8, 12.5, 15.2))
    chart_data.add_series('市场 50 分位', (24.0, 27.5, 21.0, 15.0, 19.5))
    chart_data.add_series('目标水平', (26.5, 31.0, 23.5, 17.0, 23.0))
    gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.95), Inches(2.4),
                            Inches(8.1), Inches(4.3), chart_data)
    chart = gf.chart
    chart.has_legend = True
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart.legend.include_in_layout = False
    chart.font.size = Pt(10)
    chart.font.name = FONT
    plot = chart.plots[0]
    plot.gap_width = 60
    plot.has_data_labels = True
    plot.data_labels.font.size = Pt(8.5)
    plot.data_labels.number_format = '0.0'
    plot.data_labels.number_format_is_linked = False
    colors = [RGBColor(0xC7, 0xD2, 0xE0), RGBColor(0x93, 0xB4, 0xE3), NAVY]
    for i, series in enumerate(plot.series):
        series.format.fill.solid()
        series.format.fill.fore_color.rgb = colors[i]
    textbox(s, 9.25, 2.6, 3.3, 0.4, '结论', size=13, bold=True, color=NAVY)
    textbox(s, 9.25, 3.05, 3.3, 3.4,
            '· 关键岗位普遍低于市场 50 分位 15%—25%\n\n'
            '· 技能骨干流失率高于行业均值 6 个百分点\n\n'
            '· 建议用两年时间分批补到目标水平，优先技术序列与营销序列',
            size=11, color=GREY, line_spacing=1.55)

    # ── 19 绩效框架 ──
    s = blank(prs, True); p = P(); header(s, '04 薪酬与绩效设计', p)
    title(s, '绩效管理框架', '目标—过程—评价—应用 四环闭合')
    steps = [('目标设定', '战略解码到\n部门与个人'), ('过程辅导', '季度复盘 +\n年中调整'),
             ('绩效评价', '业绩 70%\n能力态度 30%'), ('结果应用', '薪酬、晋升、\n培训、退出')]
    x = 0.95
    for i, (name, desc) in enumerate(steps):
        box = rect(s, x, 2.72, 2.6, 1.5, fill=WHITE, line=BLUE, line_w=1.2,
                   shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        shape_text(box, name, size=14, bold=True, color=NAVY, anchor=MSO_ANCHOR.TOP)
        textbox(s, x + 0.12, 3.2, 2.36, 0.9, desc, size=11, color=GREY,
                align=PP_ALIGN.CENTER, line_spacing=1.4)
        if i < 3:
            rect(s, x + 2.68, 3.28, 0.4, 0.34, fill=BLUE, shape=MSO_SHAPE.RIGHT_ARROW)
        x += 3.05
    rect(s, 0.95, 4.62, W - 1.9, 1.7, fill=LIGHT, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    textbox(s, 1.2, 4.78, W - 2.4, 1.4,
            '配套机制：\n'
            '· 部门指标不超过 6 项，个人指标不超过 4 项，避免「指标满天飞」\n'
            '· 强制分布改为「区分度控制」，前 20% 与后 10% 必须拉开差距\n'
            '· 连续两年末位，进入岗位调整或退出程序',
            size=11.5, color=NAVY, line_spacing=1.6)

    # ── 20 章节五 ──
    p = P(); section_slide(prs, '05', '实施路径与保障', '分三期推进，先试点再推开', p)

    # ── 21 三期计划 ──
    s = blank(prs, True); p = P(); header(s, '05 实施路径与保障', p)
    title(s, '三期推进计划', '18 个月完成体系落地')
    phases = [
        ('第一期', '第 1—6 月', '组织与岗位', '架构调整、部门职责界定、岗位说明书修订、序列与职级套改',
         '交付：组织手册、岗位说明书、职级套改方案', BLUE),
        ('第二期', '第 7—12 月', '薪酬与绩效', '薪酬套改、绩效制度发布、试点运行、季度复盘',
         '交付：薪酬制度、绩效管理办法、试点报告', NAVY),
        ('第三期', '第 13—18 月', '固化与优化', '全员宣贯、系统上线、年度评估、机制迭代',
         '交付：制度汇编、系统上线报告、年度评估', GREY),
    ]
    y = 2.6
    for name, period, focus, desc, deliver, color in phases:
        rect(s, 0.95, y, 0.09, 1.2, fill=color)
        textbox(s, 1.22, y + 0.02, 1.7, 0.34, name, size=13.5, bold=True, color=NAVY)
        textbox(s, 1.22, y + 0.38, 1.7, 0.3, period, size=10.5, color=GREY)
        textbox(s, 2.95, y + 0.02, 2.4, 0.34, focus, size=12.5, bold=True, color=color)
        textbox(s, 2.95, y + 0.4, 8.1, 0.36, desc, size=11.5, color=GREY)
        textbox(s, 2.95, y + 0.82, 8.6, 0.3, deliver, size=10.5, color=RGBColor(0x94, 0xA3, 0xB8))
        y += 1.42

    # ── 22 结尾 ──
    s = blank(prs); p = P()
    rect(s, 0, 0, W, H, fill=NAVY)
    rect(s, 0, 0, 0.06, H, fill=ACCENT)
    textbox(s, 1.4, 3.0, 10.0, 0.8, '谢谢聆听', size=40, bold=True, color=WHITE)
    textbox(s, 1.4, 3.9, 10.0, 0.5, '欢迎就组织、岗位、薪酬、绩效的具体问题继续交流', size=15,
            color=RGBColor(0xB6, 0xC6, 0xDA))
    rect(s, 1.42, 4.62, 1.4, 0.05, fill=ACCENT)
    textbox(s, 1.4, 6.4, 8.0, 0.35, '本文件为软件内置示例素材，内容为虚构案例，可随意删除',
            size=10.5, color=RGBColor(0x7E, 0x93, 0xAD))
    textbox(s, W - 1.9, 7.08, 1.0, 0.3, str(p), size=9.5,
            color=RGBColor(0x8A, 0x9E, 0xB8), align=PP_ALIGN.RIGHT)

    prs.save(path)
    return page[0]


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'sample.pptx'
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    n = build(out)
    size = os.path.getsize(out)
    print(f'pages={n} size={size/1024:.1f}KB path={out}')
