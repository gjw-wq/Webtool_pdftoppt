# 虚拟环境目录改名踩坑复盘与避坑指南

> **触发事件**：把项目目录从 `pdf2ppt` 改名为 `Webtool_pdftoppt`，`.venv` 随目录一起搬走，随后在 Git Bash 里 `source .venv/Scripts/activate && python app.py` 报 `ModuleNotFoundError: No module named 'customtkinter'`。
> **适用环境**：Windows + Git Bash（UCRT64）+ uv 0.11.23 + CPython 3.12.13；Python 3.10+ / virtualenv / venv 同理。
> **记录日期**：2026-11-14

---

## 0. 一句话结论

**包一个都没丢，错的是解释器。**

`.venv` **不是可重定位的**：创建时把绝对路径写进了激活脚本和 `.exe` 启动器。目录一改名，这些路径全部失效，`source activate` 把 PATH 指到一个不存在的目录，`python` 就回落到系统里下一个 Python（本机是 WorkBuddy 注入的全局 3.13.12），那个环境自然没有项目依赖。

> `uv pip list` 查的是 `.venv`（有包），`python` 跑的是全局解释器（没包）——两者不是同一个环境，这就是「明明装好了」的全部谜底。

---

## 1. 问题现象与误导点

复现命令与原始报错：

```bash
source .venv/Scripts/activate
(pdf2ppt) $ python app.py
ModuleNotFoundError: No module named 'customtkinter'
```

| 现象 | 容易误判成 | 真相 |
| --- | --- | --- |
| `uv pip list` 里 `customtkinter 6.0.0` 明明在 | 依赖没装好 / 装错地方 | 包装在 `.venv/Lib/site-packages`，位置正确 |
| 提示符是 `(pdf2ppt)` 而不是新项目名 | 只是显示名，无所谓 | 环境创建时写死的 `VIRTUAL_ENV_PROMPT`，**旧目录名的直接证据** |
| 激活后 `python` 报缺包 | 激活没生效 | 激活「生效」了，但加进 PATH 的是**失效的旧路径** |
| 直接 `.venv/Scripts/python.exe app.py` 却能跑 | 玄学 | 绕开了激活脚本，直接命中正确解释器 |

---

## 2. 一分钟诊断：三件套

```bash
which python                                             # ① 到底跑的是谁
echo $VIRTUAL_ENV                                        # ② 激活脚本把环境指到哪
python -c "import sys; print(sys.executable, sys.prefix)" # ③ 解释器自报家门
```

| 判读 | 结论 |
| --- | --- |
| `sys.prefix` 不含当前项目路径 | **确诊**：跑的不是这个 `.venv`，不用查依赖 |
| `VIRTUAL_ENV` 指向一个不存在的目录 | 激活脚本里的绝对路径已失效 |
| `which python` 落在 `.workbuddy` / anaconda / `WindowsApps` | 回落到 PATH 里下一个全局 Python |
| 三者都指向当前项目的 `.venv` | 不是路径问题，再去查包本身 |

补一条全局搜索，看还有多少文件残留旧目录名（`.exe` 是二进制，也会被搜出来）：

```bash
grep -rl --binary-files=text "pdf2ppt" .venv/Scripts | head -30
```

---

## 3. 根因拆解：三层写死的绝对路径

| 层 | 具体文件 | 写死的内容 | 改名后的后果 |
| --- | --- | --- | --- |
| ① 激活脚本 | `.venv/Scripts/activate` 第 81 行（以及 `.bat` / `.csh` / `.fish` / `.nu`） | `VIRTUAL_ENV='D:\...\uv\pdf2ppt\.venv'` | Git Bash 经 `cygpath -u` 转成 `/d/.../uv/pdf2ppt/.venv`，`PATH="$VIRTUAL_ENV/Scripts:$PATH"` 指向不存在的目录 |
| ② 命令启动器 | `flask.exe`、`pymupdf.exe`、`f2py.exe` 等 9 个 uv trampoline | PE 资源与 zip 内 `__main__.py` 的 shebang 都内嵌 `D:\...\uv\pdf2ppt\.venv\Scripts\python.exe` | 即使 PATH 修好，`flask` / `pymupdf` 这类命令仍找不到解释器 |
| ③ 附带脚本 | `vba_extract.py` 等 | shebang 里的解释器路径 | 少数工具脚本失效 |

**两个附带发现**（不是报错主因，但会变成下一个坑）：

- `uv venv` **默认不安装 pip**，激活后敲 `pip` 会提示不存在；要用 `uv pip` 或补装 `uv pip install pip`。
- 实测 `.venv/Scripts/Activate.ps1` 用 `$myinvocation.mycommand.path` 动态推算 `BASE_DIR`，**不含旧绝对路径**，不受改名影响；所以别对所有激活脚本一刀切改路径（本次只有 6 个文本文件真正需要改）。

---

## 4. 三种方案怎么选

| 方案 | 做法 | 优点 | 代价 | 适用 |
| --- | --- | --- | --- | --- |
| **A 重建（推荐）** | 不带 `.venv` 迁移，在新目录重新 `uv venv` + 装依赖 | 最干净，激活脚本与启动器路径天然正确 | 需要重装依赖（uv 缓存下十几秒）；额外包要用 freeze 清单恢复 | 改名 / 迁移 / 克隆到新路径 |
| **B 就地修复** | 修激活脚本 + 全量重装重建启动器 | 保留全部 31 个包及版本，不删环境 | 步骤多，必须先停服务，有文件锁风险 | 环境里装了大量额外包、不便重建 |
| **C 应急绕过** | 不激活，用 `uv run` 或 `.venv/Scripts/python.exe` | 一行命令立刻能跑 | 治标不治本，`flask` 等命令仍是坏的 | 临时验证、赶时间 |

**决策口诀**：能重建就重建；不能重建才就地修；临时验证用 `uv run`。

---

## 5. 方案 A：新目录重建（推荐）

```bash
# 0. 在旧目录里先退出环境，并留一份精确版本清单（可选，用于恢复额外包）
deactivate 2>/dev/null || true
uv pip freeze > .venv-restore.txt        # 留在项目根目录，别用 /tmp（Windows 原生程序不认）

# 1. 迁移源码时不要复制 .venv（它已被 .gitignore 忽略，属于可再生资源）
#    改名完成后进入新目录
cd /d/360MoveData/Users/Administrator/Desktop/uv/Webtool_pdftoppt

# 2. 重建环境
uv python install 3.12
uv venv --python 3.12

# 3. 装回依赖
uv pip install -r requirements.txt
uv pip install -r .venv-restore.txt      # 可选：恢复 freeze 里的额外包
uv pip install pip                       # 可选：让激活后 pip 也能用
rm -f .venv-restore.txt                  # 成功后清理

# 4. 验收（见第 8 节）
uv run python app.py
```

> `uv pip install -r requirements.txt` 只装 5 个声明依赖；若环境里还有 `pymupdf4llm`、`onnxruntime` 之类手动装过的包，务必用第 0 步的 freeze 清单补回。

---

## 6. 方案 B：就地修复（本次实际采用，可直接复制）

### Step 0｜先停掉所有占用 `.venv` 的进程（**最关键**）

```bash
netstat -ano | grep ":5000"          # 找到 Web 服务的 PID
```

PowerShell 里执行（或直接在运行服务的终端按 Ctrl+C）：

```powershell
Stop-Process -Id <PID> -Force
```

> ⚠️ 只要还有进程加载了 `.venv` 里的 `.pyd`，重装就会在半途报 `os error 5: 拒绝访问`，而 uv 此时**已经开始卸载**，环境会变成「缺 werkzeug」这类半坏状态。本次就是先撞了这个坑，停进程后才装回来的。

### Step 1｜留底精确版本清单

```bash
uv pip freeze > .venv-restore.txt    # 成功了才删，失败时它是救命绳
```

### Step 2｜按**字节**修正激活脚本路径

用字节替换，不要用文本编辑器或 `sed -i`：Windows 下文本模式写入会把 LF 改成 CRLF，bash 脚本会直接语法报错。

```bash
.venv/Scripts/python.exe - <<'PY'
from pathlib import Path

bs = bytes([92])                       # 反斜杠，避免转义
OLD, NEW = b"pdf2ppt", b"Webtool_pdftoppt"
pairs = [
    (b"uv" + bs + OLD + bs + b".venv", b"uv" + bs + NEW + bs + b".venv"),
    (b"uv/" + OLD + b"/.venv",         b"uv/" + NEW + b"/.venv"),
]
files = [p for p in list(Path(".venv/Scripts").glob("*")) + list(Path(".venv").glob("*.cfg"))
         if p.is_file() and p.suffix.lower() not in {".exe", ".pyd", ".dll", ".pyc"}]
for p in files:
    data = p.read_bytes()
    new = data
    for a, b in pairs:
        new = new.replace(a, b)
    if new != data:
        p.write_bytes(new)
        print("fixed:", p)
PY
```

### Step 3｜全量重装，重建 `.exe` 启动器

```bash
uv pip install --reinstall -r .venv-restore.txt
```

> `--reinstall` 会让 uv 重新生成所有 console script 启动器，把内嵌的 `python.exe` 路径刷成当前目录。只修文本脚本不够，这步不能省。

### Step 4｜补 pip、同步环境显示名、清理

```bash
uv pip install pip
.venv/Scripts/python.exe -c "from pathlib import Path; [p.write_bytes(p.read_bytes().replace(b'pdf2ppt', b'Webtool_pdftoppt')) for p in Path('.venv/Scripts').glob('activate*') if p.is_file() and b'pdf2ppt' in p.read_bytes()]"
rm -f .venv-restore.txt
```

### Step 5｜确认零残留

```bash
.venv/Scripts/python.exe -c "from pathlib import Path; print([str(p) for p in Path('.venv/Scripts').glob('*') if p.is_file() and b'pdf2ppt' in p.read_bytes()] or '无残留')"
```

---

## 7. 方案 C：应急绕过（不修根）

```bash
uv run python app.py                  # 推荐：uv 自动找当前目录的 .venv
.venv/Scripts/python.exe app.py       # 最直白：直接点名解释器
PATH="$PWD/.venv/Scripts:$PATH" python app.py   # 手动修正 PATH
```

`uv run` / `uv pip` 不依赖激活脚本里的硬编码路径，是这类环境下最稳的日常用法。

---

## 8. 验收清单

| # | 检查项 | 命令 | 期望结果 |
| --- | --- | --- | --- |
| 1 | 激活路径 | `echo $VIRTUAL_ENV` | 指向**当前项目**的 `.venv` |
| 2 | 解释器 | `python -c "import sys; print(sys.prefix)"` | 含 `Webtool_pdftoppt\.venv` |
| 3 | 依赖 | `python -c "import customtkinter; print(customtkinter.__version__)"` | `6.0.0`，无报错 |
| 4 | pip | `pip --version` | 路径落在 `.venv\Lib\site-packages` |
| 5 | 启动器 | `flask --version` | 正常输出版本，不报「找不到 python」 |
| 6 | 桌面 GUI | `python app.py` | 正常弹出窗口（Tk 8.6） |
| 7 | Web 服务 | `curl --noproxy "*" http://127.0.0.1:5000/api/health` | `200`（本机代理会拦 localhost，必须带 `--noproxy "*"`） |
| 8 | 旧路径 | 第 6 节 Step 5 | 输出「无残留」 |

---

## 9. 预防 SOP：下次改名/迁移照着做

1. **改名先退出环境**：`deactivate`，并关掉 Web 服务、GUI、IDE 里正在用该解释器的进程。
2. **只搬源码，不搬 `.venv`**：它已在 `.gitignore` 里，属于可再生资源；复制它等于把一堆绝对路径一起复制过去。
3. **到新目录重建**：`uv venv --python 3.12 && uv pip install -r requirements.txt`；有额外包先 `uv pip freeze` 留底。
4. **日常优先 `uv run` / `uv pip`**：不激活、不依赖激活脚本，天然免疫路径写死。
5. **需要可复现就上锁文件**：`pyproject.toml` + `uv.lock` + `uv sync`，换机器也不会装出不同版本。
6. **改名后必跑三件套**（第 2 节），并 `grep -rl "旧目录名" .venv/Scripts` 扫一遍。
7. **看到 `(旧项目名)` 提示符就警觉**：它不是装饰，是环境身份的线索。

---

## 10. 一页速记

1. `.venv` 带绝对路径，**目录一改名，激活脚本和 `.exe` 启动器同时失效**。
2. 「`uv pip list` 有包 / `python` 报缺包」= 两个解释器，`which python` 一眼拆穿。
3. 首选**新目录重建**，别复制 `.venv`；要保留全部包才走就地修复。
4. 就地修复顺序：**停服务 → freeze 留底 → 字节改脚本 → `--reinstall` 重建启动器 → 装 pip → 验收**。
5. 重装中报 `os error 5` 是文件被锁，别慌：停掉进程后重跑同一条命令即可，freeze 清单别删。
6. 长期免疫：`uv run python app.py`，不激活。
