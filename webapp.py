# -*- coding: utf-8 -*-
"""
PDF2PPT Web 界面后端（Flask）

- 不改动原有 app.py（桌面版）与 pdf2ppt.py（转换核心），仅在其之上加一层 Web 外壳
- 转换耗时长，采用「后台线程 + 任务 ID 轮询」；日志实时推送到前端
- 同一时间只允许一个转换任务，避免多个任务共用 root logger 导致日志串扰
- 预览由 preview_utils.py 把 PPTX 结构重建为 HTML，无需 Office / LibreOffice
"""

import argparse
import logging
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory

import pdf2ppt
import preview_utils

BASE = Path(__file__).resolve().parent
OUTPUT_DIR = BASE / "web_outputs"
DEMO_DIR = BASE / "demo"
CACHE_DIR = OUTPUT_DIR / "_cache"
ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB
app.json.ensure_ascii = False
app.config["TEMPLATES_AUTO_RELOAD"] = True   # 改模板后无需重启服务

JOBS = {}
LOCK = threading.Lock()
ACTIVE_JID = None          # 当前正在转换的任务（日志归属）
_active_lock = threading.Lock()


# --------------------------------------------------------------------------
# 任务状态与日志
# --------------------------------------------------------------------------

def _new_job(filename, pdf_path, pptx_path, asset_dir, page_count):
    return {
        "id": uuid.uuid4().hex[:12],
        "filename": filename,
        "state": "queued",              # queued / running / done / error
        "stage": "准备中",
        "progress": 2,
        "logs": [],
        "error": "",
        "pdfPath": str(pdf_path),
        "pptxPath": str(pptx_path),
        "assetDir": str(asset_dir),
        "assetBase": "",               # 建 job 后补全
        "pageCount": page_count,
        "parsed": 0,
        "generated": 0,
        "preview": None,
        "isDemo": False,
        "created": time.time(),
    }


def _push_log(job, level, msg):
    job["logs"].append({
        "t": datetime.now().strftime("%H:%M:%S"),
        "level": level,
        "msg": msg,
    })
    if len(job["logs"]) > 600:
        del job["logs"][:200]
    _advance(job, msg)


def _advance(job, msg):
    """根据核心库日志推断阶段与进度（不改动核心库）"""
    total = max(1, job.get("pageCount") or 1)
    p = job["progress"]
    if "正在拆分" in msg or "批量上传" in msg:
        job["stage"] = "拆分并上传页面"
        job["progress"] = max(p, 8)
    elif ("正在等待任务" in msg or "使用缓存数据" in msg
          or "轮询" in msg or "状态:" in msg):
        job["stage"] = "MinerU 解析中"
        job["parsed"] += 1
        job["progress"] = max(p, min(70, 10 + int(60 * job["parsed"] / total)))
    elif "生成幻灯片" in msg or "开始合成" in msg:
        job["stage"] = "合成 PPTX"
        if "生成幻灯片" in msg:
            job["generated"] += 1
        job["progress"] = max(p, min(96, 70 + int(26 * job["generated"] / total)))
    elif "完成:" in msg:
        job["stage"] = "构建预览"
        job["progress"] = max(p, 97)


class JobLogHandler(logging.Handler):
    """把核心库的 logging 输出转发给当前活跃任务"""

    def emit(self, record):
        with _active_lock:
            jid = ACTIVE_JID
        if not jid:
            return
        try:
            msg = record.getMessage()
        except Exception:
            return
        with LOCK:
            job = JOBS.get(jid)
            if job and job["state"] in ("queued", "running"):
                _push_log(job, record.levelname, msg)


_handler = JobLogHandler()
_handler.setFormatter(logging.Formatter("%(message)s"))
_root = logging.getLogger()
_root.setLevel(logging.INFO)
if not any(isinstance(h, JobLogHandler) for h in _root.handlers):
    _root.addHandler(_handler)
if not any(isinstance(h, logging.StreamHandler) for h in _root.handlers):
    _root.addHandler(logging.StreamHandler())


def _default_token():
    try:
        import config
        return getattr(config, "MINERU_TOKEN", "") or ""
    except Exception:
        return ""


def _page_count(pdf_path):
    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        doc = fitz.open(pdf_path)
        n = len(doc)
        doc.close()
        return n
    except Exception:
        return 0


# --------------------------------------------------------------------------
# 转换任务
# --------------------------------------------------------------------------

def run_conversion(jid):
    global ACTIVE_JID
    with LOCK:
        job = JOBS.get(jid)
        if not job:
            return
        job["state"] = "running"
        job["stage"] = "开始转换"
        _push_log(job, "INFO", "任务已启动，正在调用 MinerU 解析服务")

    with _active_lock:
        ACTIVE_JID = jid

    try:
        pdf2ppt.convert_pdf_to_ppt(
            pdf_input_path=job["pdfPath"],
            ppt_output_path=job["pptxPath"],
            mineru_token=job["token"],
            ppt_slide_width=job["width"],
            ppt_slide_height=job["height"],
            use_cache=job["useCache"],
            cache_dir=str(CACHE_DIR),
            remove_watermark=job["removeWatermark"],
        )

        with LOCK:
            job["stage"] = "构建预览"
            job["progress"] = 98
            _push_log(job, "INFO", "PPTX 已生成，正在渲染预览")

        preview = preview_utils.build_preview(
            job["pptxPath"], job["pdfPath"], job["assetDir"], job["assetBase"]
        )

        with LOCK:
            job["preview"] = preview
            job["state"] = "done"
            job["stage"] = "转换完成"
            job["progress"] = 100
            _push_log(job, "INFO", "完成：共 %d 页幻灯片" % preview["slideCount"])

    except Exception as e:
        logging.exception("转换失败")
        with LOCK:
            job["state"] = "error"
            job["stage"] = "转换失败"
            job["error"] = str(e)
            _push_log(job, "ERROR", "转换失败：%s" % e)
    finally:
        with _active_lock:
            ACTIVE_JID = None


def _any_running():
    with LOCK:
        return any(j["state"] in ("queued", "running") for j in JOBS.values())


def _build_preview_for(job):
    """demo / 已完成任务的预览数据（线程安全地在锁外计算）"""
    return preview_utils.build_preview(
        job["pptxPath"], job["pdfPath"], job["assetDir"], job["assetBase"]
    )


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------

@app.errorhandler(413)
def too_large(_e):
    return jsonify({"ok": False, "error": "文件超过 100 MB 限制"}), 413


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "service": "pdf2ppt-web"})


@app.get("/api/config")
def api_config():
    return jsonify({
        "hasDefaultToken": bool(_default_token()),
        "demoAvailable": (DEMO_DIR / "demo.pptx").exists(),
        "maxUploadMB": 100,
    })


@app.post("/api/convert")
def api_convert():
    if _any_running():
        return jsonify({"ok": False, "error": "已有转换任务进行中，请等待完成"}), 409

    file = request.files.get("pdf")
    if file is None or not file.filename:
        return jsonify({"ok": False, "error": "请选择 PDF 文件"}), 400

    filename = os.path.basename(file.filename)
    if not filename.lower().endswith(".pdf"):
        return jsonify({"ok": False, "error": "只支持 .pdf 文件"}), 400

    token = (request.form.get("token") or "").strip() or _default_token()
    if not token:
        return jsonify({"ok": False, "error": "请填写 MinerU Token（或在 config.py 中配置）"}), 400

    ratio = request.form.get("ratio", "16:9")
    width, height = (10, 7.5) if ratio == "4:3" else (16, 9)
    remove_watermark = request.form.get("removeWatermark", "1") not in ("0", "false", "off")
    use_cache = request.form.get("useCache", "0") in ("1", "true", "on")

    jid = uuid.uuid4().hex[:12]
    job_dir = OUTPUT_DIR / jid
    asset_dir = job_dir / "assets"
    job_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)

    pdf_path = job_dir / "input.pdf"
    pptx_path = job_dir / "result.pptx"
    file.save(str(pdf_path))

    job = _new_job(filename, pdf_path, pptx_path, asset_dir, _page_count(str(pdf_path)))
    job["id"] = jid
    job["assetBase"] = "/api/asset/%s" % jid
    job["token"] = token
    job["width"] = width
    job["height"] = height
    job["useCache"] = use_cache
    job["removeWatermark"] = remove_watermark

    with LOCK:
        JOBS[jid] = job

    threading.Thread(target=run_conversion, args=(jid,), daemon=True).start()
    return jsonify({"ok": True, "jobId": jid})


@app.post("/api/demo")
def api_demo():
    """加载内置示例，无需 Token 即可体验完整预览"""
    if _any_running():
        return jsonify({"ok": False, "error": "已有转换任务进行中，请稍后再试"}), 409

    src_pptx = DEMO_DIR / "demo.pptx"
    src_pdf = DEMO_DIR / "demo.pdf"
    if not src_pptx.exists():
        return jsonify({"ok": False, "error": "未找到 demo/demo.pptx"}), 404

    jid = uuid.uuid4().hex[:12]
    job_dir = OUTPUT_DIR / jid
    asset_dir = job_dir / "assets"
    job_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)

    pdf_path = job_dir / "input.pdf"
    pptx_path = job_dir / "result.pptx"
    shutil.copyfile(str(src_pptx), str(pptx_path))
    if src_pdf.exists():
        shutil.copyfile(str(src_pdf), str(pdf_path))
        pdf_for_preview = str(pdf_path)
        pages = _page_count(str(pdf_path))
    else:
        pdf_for_preview = ""
        pages = 0

    job = _new_job("demo.pptx（内置示例）", pdf_for_preview, pptx_path, asset_dir, pages)
    job["id"] = jid
    job["assetBase"] = "/api/asset/%s" % jid
    job["isDemo"] = True
    job["state"] = "running"
    job["stage"] = "构建预览"

    with LOCK:
        JOBS[jid] = job
        _push_log(job, "INFO", "已加载内置示例，正在渲染预览")

    try:
        preview = _build_preview_for(job)
        with LOCK:
            job["preview"] = preview
            job["state"] = "done"
            job["stage"] = "示例已就绪"
            job["progress"] = 100
            _push_log(job, "INFO", "示例预览完成：%d 页幻灯片 / %d 页原稿"
                      % (preview["slideCount"], preview["pdfPageCount"]))
    except Exception as e:
        with LOCK:
            job["state"] = "error"
            job["error"] = str(e)
            _push_log(job, "ERROR", "示例预览失败：%s" % e)
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "jobId": jid})


@app.get("/api/status/<jid>")
def api_status(jid):
    with LOCK:
        job = JOBS.get(jid)
        if not job:
            return jsonify({"ok": False, "error": "任务不存在或已过期"}), 404
        since = int(request.args.get("since", "0") or 0)
        logs = job["logs"][since:]
        data = {
            "ok": True,
            "id": jid,
            "state": job["state"],
            "stage": job["stage"],
            "progress": job["progress"],
            "error": job["error"],
            "filename": job["filename"],
            "isDemo": job["isDemo"],
            "logs": logs,
            "logCount": len(job["logs"]),
            "hasPreview": job["preview"] is not None,
        }
    return jsonify(data)


@app.get("/api/preview/<jid>")
def api_preview(jid):
    with LOCK:
        job = JOBS.get(jid)
        preview = job["preview"] if job else None
        filename = job["filename"] if job else ""
    if not preview:
        return jsonify({"ok": False, "error": "预览尚未生成"}), 404
    return jsonify({"ok": True, "filename": filename, **preview})


@app.get("/api/asset/<jid>/<path:filename>")
def api_asset(jid, filename):
    if not ASSET_NAME_RE.match(filename) or ".." in filename:
        return "invalid filename", 400
    with LOCK:
        job = JOBS.get(jid)
        asset_dir = job["assetDir"] if job else None
    if not asset_dir or not os.path.isfile(os.path.join(asset_dir, filename)):
        return "not found", 404
    return send_from_directory(asset_dir, filename)


@app.get("/api/download/<jid>")
def api_download(jid):
    with LOCK:
        job = JOBS.get(jid)
        pptx_path = job["pptxPath"] if job else None
        name = job["filename"] if job else "result.pptx"
    if not pptx_path or not os.path.isfile(pptx_path):
        return "not found", 404
    base = os.path.splitext(name)[0] or "result"
    return send_file(pptx_path, as_attachment=True, download_name=base + ".pptx")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PDF2PPT Web 界面")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=5000, help="端口，默认 5000")
    parser.add_argument("--debug", action="store_true", help="开启 Flask 调试模式")
    args = parser.parse_args()

    print("=" * 56)
    print("  PDF2PPT Web 界面已启动")
    print("  打开浏览器访问: http://%s:%d" % (args.host, args.port))
    print("  未配置 Token 时可点「加载示例」直接体验预览")
    print("=" * 56)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)
