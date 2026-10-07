import os
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

    try:
        font = ImageFont.truetype("msyh.ttc", 14)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    tx = (width - bbox[2] + bbox[0]) // 2
    ty = (height - bbox[3] + bbox[1]) // 2
    draw.text((tx, ty), label, fill='#37474F', font=font)
    img.save(output_path)
    return output_path


def generate_thumbnails(file_path, output_dir, width=THUMBNAIL_WIDTH,
                        height=THUMBNAIL_HEIGHT, slides_data=None):
    """Generate thumbnails. Uses COM when available, else placeholders.
    Pass slides_data (already-parsed slides) to avoid re-parsing on fallback."""
    try:
        result = generate_thumbnails_com(file_path, output_dir, width, height)
        if result:
            return result
    except Exception as e:
        _log.warning("Thumbnail COM failed for %s, using placeholders: %s",
                     file_path, e)

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
