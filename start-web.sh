#!/usr/bin/env bash
# PDF2PPT Web 工作台一键启动（Git Bash / MSYS2）
# 用法：
#   ./start-web.sh                     默认 5000 端口，启动服务并打开浏览器
#   ./start-web.sh 8080               指定端口
#   ./start-web.sh 5000 --no-browser  只启动服务、不打开浏览器（自动化/CI 用）
#   ./start-web.sh stop               停止占用默认端口的服务
#   ./start-web.sh stop 8080          停止指定端口的服务
set -u

cd "$(dirname "$0")" || exit 1

PY=".venv/Scripts/python.exe"
LOG="webapp_run.log"
PID_FILE=".web.pid"
PORT=5000
OPEN_BROWSER=1
STOP=0
STARTED=0

for arg in "$@"; do
  case "$arg" in
    stop)            STOP=1 ;;
    --no-browser)    OPEN_BROWSER=0 ;;
    [0-9]*)          PORT="$arg" ;;
    *) echo "未知参数: $arg（端口须为数字）"; exit 1 ;;
  esac
done

# 本机代理会拦截 127.0.0.1，必须显式绕开；同时让 Flask 日志按 UTF-8 输出
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
export PYTHONIOENCODING=utf-8

HEALTH="http://127.0.0.1:${PORT}/api/health"
URL="http://127.0.0.1:${PORT}/?demo=1"
healthy() { curl -fsS --noproxy "*" -o /dev/null "$HEALTH" 2>/dev/null; }

# ---- 停止 ----------------------------------------------------------------
if [ "$STOP" -eq 1 ]; then
  pid=$(netstat -ano | awk -v p=":${PORT}" '$2 ~ p"$" && $4 == "LISTENING" {sub(/\r$/,"",$5); print $5; exit}')
  if [ -n "${pid:-}" ]; then
    if [ -f "$PY" ]; then
      # os.kill(SIGTERM) 在 Windows 上等价于终止指定 PID 的进程，无需 PowerShell
      if "$PY" -c "import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGTERM)" "$pid" 2>/dev/null; then
        echo "已停止服务（端口 ${PORT}，PID ${pid}）"
      else
        echo "停止失败，请手动结束 PID ${pid}"
      fi
    else
      echo "[错误] 未找到 $PY，请手动结束 PID ${pid}"
    fi
  else
    echo "端口 ${PORT} 上没有正在监听的服务"
  fi
  rm -f "$PID_FILE"
  exit 0
fi

# ---- 环境自检 ------------------------------------------------------------
if [ ! -f "$PY" ]; then
  echo "[错误] 未找到虚拟环境解释器：$PY"
  echo "请先执行：uv venv --python 3.12 && uv pip install -r requirements.txt"
  exit 1
fi

# ---- 启动或复用 ----------------------------------------------------------
if healthy; then
  echo "[1/3] 端口 ${PORT} 上已有服务，直接复用"
else
  echo "[1/3] 正在启动 Web 服务（端口 ${PORT}）..."
  "$PY" webapp.py --port "$PORT" > "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  STARTED=1
  ok=0
  for _ in $(seq 1 25); do
    if healthy; then ok=1; break; fi
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[错误] 服务进程已退出，日志末尾："
      tail -n 25 "$LOG"
      exit 1
    fi
    sleep 1
  done
  if [ "$ok" -ne 1 ]; then
    echo "[错误] 等待 25 秒仍无响应，日志末尾："
    tail -n 25 "$LOG"
    exit 1
  fi
fi

# ---- 打开浏览器 ----------------------------------------------------------
if [ "$OPEN_BROWSER" -eq 1 ]; then
  echo "[2/3] 打开浏览器..."
  EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  if [ -x "$EDGE" ]; then
    # --no-proxy-server 防止系统代理把 localhost 请求拦成 502
    "$EDGE" --no-proxy-server "$URL" >/dev/null 2>&1 &
  else
    "$PY" -c "import sys, webbrowser; webbrowser.open(sys.argv[1])" "$URL" >/dev/null 2>&1 &
  fi
else
  echo "[2/3] 已跳过打开浏览器（--no-browser）"
fi

echo "[3/3] 就绪"
echo "  访问地址 : $URL"
echo "  服务日志 : $LOG"
echo "  停止服务 : ./start-web.sh stop $PORT"
echo
if [ "$STARTED" -eq 1 ]; then
  echo "服务运行中，按 Ctrl+C 停止（或另开终端执行 ./start-web.sh stop $PORT）"
  wait "$(cat "$PID_FILE")" 2>/dev/null || true
else
  echo "（复用已有服务；关闭其窗口或执行 ./start-web.sh stop $PORT 可停止）"
fi
