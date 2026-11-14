# -*- coding: utf-8 -*-
"""
预览数据构建：把 PPTX 与 PDF 转成前端可直接渲染的结构。

设计要点
--------
本项目处理的 PPTX 不是「整页截图」，而是由绝对定位的文本框、图片、
原生表格以及纯色矩形形状组成的可编辑页面。因此无需 Office / LibreOffice，
只要把每个 shape 的 EMU 坐标换算成百分比，就能在浏览器里高保真重建幻灯片。

所有长度统一以「每英寸 80 逻辑像素」为基准（16:9 -> 1280x720，
4:3 -> 800x600；20x11.25in -> 1600x900）。前端固定这个逻辑画布尺寸，
再用 transform: scale 适配容器，字号与坐标会随画布等比缩放，不会失真。
"""

import os
import io
import logging
from pathlib import Path

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24 推荐入口
except ImportError:  # 兼容旧版本
    import fitz
from pptx import Presentation
from pptx.enum.text import PP_ALIGN

try:
    from pptx.enum.dml import MSO_FILL
    SOLID_FILL = MSO_FILL.SOLID
except ImportError:  # 兼容旧版 python-pptx
    SOLID_FILL = 1

EMU_PER_INCH = 914400
EMU_PER_PT = 12700
PX_PER_INCH = 80                      # 逻辑画布基准
PX_PER_PT = PX_PER_INCH / 72.0       # 80 / 72 ≈ 1.1111


def _pct(value, total):
    if not total:
        return 0.0
    return round(value / total * 100, 4)


def _px(length):
    """EMU -> 逻辑像素"""
    if length is None:
        return 0
    return round(length / EMU_PER_INCH * PX_PER_INCH, 2)


def _pt_size(font):
    """从 Font 对象取字号（pt），兼容 None"""
    if font is None or font.size is None:
        return None
    try:
        return float(font.size.pt)
    except Exception:
        try:
            return float(font.size) / EMU_PER_PT
        except Exception:
            return None


def _color(font):
    """提取字体颜色，PPT 默认黑"""
    try:
        c = font.color
        if c is not None and c.type is not None and c.rgb is not None:
            return "#%s" % str(c.rgb)
    except Exception:
        pass
    return "#1a1a1a"


def _align(paragraph):
    mapping = {
        PP_ALIGN.CENTER: "center",
        PP_ALIGN.RIGHT: "right",
        PP_ALIGN.JUSTIFY: "justify",
    }
    return mapping.get(paragraph.alignment, "left")


def _text_shape(shape, slide_w, slide_h):
    tf = shape.text_frame
    paragraphs = []
    for p in tf.paragraphs:
        size_pt = _pt_size(p.font)
        bold = p.font.bold
        italic = p.font.italic
        color = _color(p.font)
        font_name = None
        try:
            font_name = p.font.name
        except Exception:
            pass

        # run 上单独设置的格式优先
        for run in p.runs:
            run_size = _pt_size(run.font)
            if run_size is not None:
                size_pt = run_size
            if run.font.bold is not None:
                bold = run.font.bold
            if run.font.italic is not None:
                italic = run.font.italic
            try:
                if run.font.color and run.font.color.type is not None and run.font.color.rgb is not None:
                    color = _color(run.font)
            except Exception:
                pass
            try:
                if run.font.name:
                    font_name = run.font.name
            except Exception:
                pass
            break  # 本项目每个段落基本只有一个 run

        text = p.text
        if text is None:
            text = ""
        paragraphs.append({
            "text": text,
            "size": round((size_pt or 18) * PX_PER_PT, 2),
            "bold": bool(bold),
            "italic": bool(italic),
            "color": color,
            "align": _align(p),
            "font": font_name or "Microsoft YaHei",
        })

    if not paragraphs:
        return None

    # PPT 文本框默认内边距：左右 0.1in、上下 0.05in
    pad = [
        _px(tf.margin_top) if tf.margin_top is not None else 4,
        _px(tf.margin_right) if tf.margin_right is not None else 8,
        _px(tf.margin_bottom) if tf.margin_bottom is not None else 4,
        _px(tf.margin_left) if tf.margin_left is not None else 8,
    ]

    return {
        "type": "text",
        "x": _pct(shape.left, slide_w),
        "y": _pct(shape.top, slide_h),
        "w": _pct(shape.width, slide_w),
        "h": _pct(shape.height, slide_h),
        "pad": pad,
        "wrap": tf.word_wrap is not False,
        "paragraphs": paragraphs,
    }


def _table_shape(shape, slide_w, slide_h, asset_dir, asset_base, name):
    table = shape.table
    rows = []
    font_px = 14
    for r_idx, row in enumerate(table.rows):
        cells = []
        for c_idx, cell in enumerate(row.cells):
            cells.append(cell.text)
            if r_idx == 0 and c_idx == 0:
                for p in cell.text_frame.paragraphs:
                    for run in p.runs:
                        s = _pt_size(run.font)
                        if s:
                            font_px = round(s * PX_PER_PT, 2)
                            break
                    break
        rows.append(cells)

    return {
        "type": "table",
        "x": _pct(shape.left, slide_w),
        "y": _pct(shape.top, slide_h),
        "w": _pct(shape.width, slide_w),
        "h": _pct(shape.height, slide_h),
        "rows": rows,
        "size": font_px,
    }


def _image_shape(shape, slide_w, slide_h, asset_dir, asset_base, name):
    try:
        image = shape.image
        ext = (image.ext or "png").lower()
        if ext == "jpeg":
            ext = "jpg"
        filename = "%s.%s" % (name, ext)
        with open(os.path.join(asset_dir, filename), "wb") as f:
            f.write(image.blob)
        return {
            "type": "image",
            "x": _pct(shape.left, slide_w),
            "y": _pct(shape.top, slide_h),
            "w": _pct(shape.width, slide_w),
            "h": _pct(shape.height, slide_h),
            "src": "%s/%s" % (asset_base, filename),
        }
    except Exception as e:
        logging.warning("预览图片提取失败 %s: %s", name, e)
        return None


def _shape_fill(shape):
    """提取形状的纯色填充（#RRGGBB）；渐变 / 图片 / 无填充返回 None"""
    try:
        fill = shape.fill
        if fill is None or fill.type != SOLID_FILL:
            return None
        rgb = fill.fore_color.rgb
        if rgb is None:
            return None
        return "#%s" % str(rgb)
    except Exception:
        return None


def _slide_background(slide):
    """幻灯片级纯色背景；很多稿子改用全屏矩形铺底，此时返回 None"""
    try:
        fill = slide.background.fill
        if fill.type == SOLID_FILL and fill.fore_color.rgb is not None:
            return "#%s" % str(fill.fore_color.rgb)
    except Exception:
        pass
    return None


def _rect_shape(shape, slide_w, slide_h, fill):
    """纯色矩形 / 圆角矩形：深色底、卡片、分隔线都靠它还原"""
    item = {
        "type": "rect",
        "x": _pct(shape.left, slide_w),
        "y": _pct(shape.top, slide_h),
        "w": _pct(shape.width, slide_w),
        "h": _pct(shape.height, slide_h),
        "fill": fill,
    }
    try:
        if "ROUND" in str(shape.auto_shape_type or "").upper():
            item["radius"] = 8
    except Exception:
        pass
    # 少数形状会同时带文字，把段落信息一起交给前端叠加渲染
    try:
        if shape.has_text_frame and shape.text_frame.text.strip():
            text = _text_shape(shape, slide_w, slide_h)
            if text:
                item["paragraphs"] = text["paragraphs"]
                item["pad"] = text["pad"]
                item["wrap"] = text["wrap"]
    except Exception:
        pass
    return item


def build_slides(pptx_path, asset_dir, asset_base):
    """PPTX -> 幻灯片 JSON 列表 + 画布尺寸"""
    prs = Presentation(pptx_path)
    slide_w, slide_h = prs.slide_width, prs.slide_height
    canvas = {
        "w": round(slide_w / EMU_PER_INCH * PX_PER_INCH),
        "h": round(slide_h / EMU_PER_INCH * PX_PER_INCH),
        "ratio": round(slide_w / slide_h, 4),
    }

    slides = []
    for s_idx, slide in enumerate(prs.slides, start=1):
        shapes = []
        for i, shape in enumerate(slide.shapes, start=1):
            name = "s%d_%d" % (s_idx, i)
            item = None
            try:
                if shape.has_table:
                    item = _table_shape(shape, slide_w, slide_h, asset_dir, asset_base, name)
                elif shape.shape_type == 13:  # PICTURE
                    item = _image_shape(shape, slide_w, slide_h, asset_dir, asset_base, name)
                elif shape.shape_type == 1:  # AUTO_SHAPE：背景 / 卡片 / 装饰块
                    fill = _shape_fill(shape)
                    if fill:
                        item = _rect_shape(shape, slide_w, slide_h, fill)
                    elif shape.has_text_frame:
                        item = _text_shape(shape, slide_w, slide_h)
                elif shape.has_text_frame:
                    item = _text_shape(shape, slide_w, slide_h)
            except Exception as e:
                logging.warning("预览 shape 解析失败 %s: %s", name, e)
            if item:
                shapes.append(item)
        slides.append({
            "index": s_idx,
            "shapes": shapes,  # 顺序即 z-order，铺底矩形在最前
            "background": _slide_background(slide),
        })

    return canvas, slides


def render_pdf_pages(pdf_path, asset_dir, asset_base, zoom=1.4):
    """PDF -> 每页 PNG，用于「转换前」对照预览"""
    if not pdf_path or not os.path.exists(pdf_path):
        return []
    pages = []
    try:
        doc = fitz.open(pdf_path)
        matrix = fitz.Matrix(zoom, zoom)
        for i, page in enumerate(doc, start=1):
            filename = "pdf-%d.png" % i
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            pix.save(os.path.join(asset_dir, filename))
            pages.append({
                "index": i,
                "src": "%s/%s" % (asset_base, filename),
                "w": pix.width,
                "h": pix.height,
            })
        doc.close()
    except Exception as e:
        logging.warning("PDF 预览渲染失败: %s", e)
        return []
    return pages


def build_preview(pptx_path, pdf_path, asset_dir, asset_base):
    """构建完整预览数据包"""
    Path(asset_dir).mkdir(parents=True, exist_ok=True)
    canvas, slides = build_slides(pptx_path, asset_dir, asset_base)
    pdf_pages = render_pdf_pages(pdf_path, asset_dir, asset_base)
    return {
        "canvas": canvas,
        "slides": slides,
        "pdfPages": pdf_pages,
        "slideCount": len(slides),
        "pdfPageCount": len(pdf_pages),
    }
