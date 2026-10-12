import os
import shutil
import sys
import logging
from PIL import Image, ImageDraw, ImageFont

from logger import get_logger

_log = get_logger(__name__)

THUMBNAIL_WIDTH = 960
THUMBNAIL_HEIGHT = 540
CANVAS_BG = '#F0F0F0'


def _fit_to_canvas(img, width, height):
    """Resize image to fit within width×height, then center on a fixed canvas.
    Returns a new Image of exactly width×height — eliminates size jitter in grids."""
    img = img.copy()
    img.thumbnail((width, height), Image.LANCZOS)
    canvas = Image.new('RGB', (width, height), CANVAS_BG)
    ox = (width - img.width) // 2
    oy = (height - img.height) // 2
    canvas.paste(img, (ox, oy))
    return canvas


def _load_font(size=14):
    """按平台挑一个能显示中文的字体（占位图上要写中文标题）。

    找不到任何一个就退 Pillow 默认字体（英文可读、中文会变方块），不让它抛异常。
    """
    candidates = [
        '/System/Library/Fonts/PingFang.ttc',          # macOS
        '/System/Library/Fonts/Hiragino Sans GB.ttc',  # macOS 旧版
        '/System/Library/Fonts/STHeiti Medium.ttc',    # macOS 兜底
        'C:/Windows/Fonts/msyh.ttc',                   # Windows 微软雅黑
        'msyh.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',  # Linux
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def generate_thumbnails_com(file_path, output_dir, width=THUMBNAIL_WIDTH,
                            height=THUMBNAIL_HEIGHT):
    """Export all slides as PNG thumbnails via PowerPoint COM."""
    from com_utils import powerpoint_app, open_presentation

    os.makedirs(output_dir, exist_ok=True)
    thumbnails = []

    try:
        with powerpoint_app() as ppt_app:
            with open_presentation(ppt_app, file_path, read_only=True) as pres:
                for i in range(1, pres.Slides.Count + 1):
                    out_path = os.path.join(output_dir, f"slide_{i}.png")
                    pres.Slides(i).Export(out_path, "PNG")
                    try:
                        img = Image.open(out_path)
                        img = _fit_to_canvas(img, width, height)
                        img.save(out_path)
                    except Exception:
                        pass
                    thumbnails.append(out_path)
    except Exception as e:
        _log.error("COM thumbnail error for %s: %s", file_path, e)

    return thumbnails


def _placeholder(output_path, slide_number, title='',
                 width=THUMBNAIL_WIDTH, height=THUMBNAIL_HEIGHT):
    """Generate a simple placeholder thumbnail."""
    img = Image.new('RGB', (width, height), color='#E8EAF6')
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width - 1, height - 1], outline='#9FA8DA', width=2)

    label = f"Slide {slide_number}"
    if title:
        label += f"\n{title[:30]}"

    font = _load_font(14)

    bbox = draw.textbbox((0, 0), label, font=font)
    tx = (width - bbox[2] + bbox[0]) // 2
    ty = (height - bbox[3] + bbox[1]) // 2
    draw.text((tx, ty), label, fill='#37474F', font=font)
    img.save(output_path)
    return output_path


def generate_thumbnails_libreoffice(file_path, output_dir,
                                    width=THUMBNAIL_WIDTH,
                                    height=THUMBNAIL_HEIGHT, dpi=150):
    """Render every slide via headless LibreOffice → PDF → per-page PNG.

    macOS / Linux 上的 PowerPoint 替代方案（需已安装 LibreOffice）。
    """
    import libreoffice

    if not libreoffice.is_available():
        raise RuntimeError(libreoffice.missing_hint())

    import pymupdf

    os.makedirs(output_dir, exist_ok=True)
    pdf_path, tmp_root = libreoffice.convert(file_path, 'pdf')
    thumbnails = []
    try:
        with pymupdf.open(pdf_path) as doc:
            for i, page in enumerate(doc, start=1):
                pix = page.get_pixmap(dpi=dpi, alpha=False)
                img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
                img = _fit_to_canvas(img, width, height)
                out_path = os.path.join(output_dir, f"slide_{i}.png")
                img.save(out_path)
                thumbnails.append(out_path)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    return thumbnails


_hint_logged = False


def _renderers():
    """按平台给出真实渲染后端的尝试顺序。"""
    if sys.platform == 'win32':
        # Windows：有 Office 就用 COM；没 Office 但装了 LibreOffice 也能出真图
        return [generate_thumbnails_com, generate_thumbnails_libreoffice]
    return [generate_thumbnails_libreoffice]


def generate_thumbnails(file_path, output_dir, width=THUMBNAIL_WIDTH,
                        height=THUMBNAIL_HEIGHT, slides_data=None):
    """Generate thumbnails: 真实渲染优先，所有后端都失败才退占位图。
    Pass slides_data (already-parsed slides) to avoid re-parsing on fallback."""
    global _hint_logged
    for renderer in _renderers():
        try:
            result = renderer(file_path, output_dir, width, height)
        except Exception as e:
            _log.warning("缩略图后端 %s 失败（%s）：%s",
                         renderer.__name__, os.path.basename(file_path), e)
            continue
        if result:
            return result

    # 全后端失败：多数情况是缺渲染引擎（没装 Office / LibreOffice），提示一次
    if not _hint_logged:
        try:
            import libreoffice
            if not libreoffice.is_available():
                _log.warning('%s', libreoffice.missing_hint())
                _hint_logged = True
        except Exception:
            pass

    # Reuse already-parsed slides when provided to avoid a second parse
    slides = slides_data
    if slides is None:
        from ppt_parser import parse_file, PartialParseError
        try:
            slides = parse_file(file_path)
        except PartialParseError as e:
            slides = e.slides_data
    os.makedirs(output_dir, exist_ok=True)
    thumbs = []
    for s in slides:
        out = os.path.join(output_dir, f"slide_{s['slide_number']}.png")
        _placeholder(out, s['slide_number'], s.get('title', ''), width, height)
        thumbs.append(out)
    return thumbs
