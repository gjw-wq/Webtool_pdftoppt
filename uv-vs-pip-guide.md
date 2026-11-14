# uv 与 pip 小白指南：从三个报错到正确上手

> **适用环境**：Windows + Git Bash（UCRT64）+ uv，项目目录 `pdf2ppt`
> **阅读目标**：看懂报错、会建环境、会装依赖、真正明白 uv 和 pip 谁管什么
> **本文所有命令只作说明，未在机器上执行**

---

## 0. 先记住一句话

**pip 只负责「往环境里装包」；uv 一个人包办「装 Python → 建环境 → 装包 → 锁版本」。**

还有一条最反直觉、也最省事的规则：

> 用 uv 时**不一定要激活环境**。`uv pip install`、`uv run` 会自己去找当前目录下的 `.venv`。
> 只有当你直接敲 `python` 或 `pip` 时，才必须先激活。

---

## 1. 先看懂这三层（明辨区别的关键）

把项目环境想成装修：

| 层 | 是什么 | 通俗类比 | pip 管不管 | uv 管不管 |
|---|---|---|---|---|
| 第 1 层 | Python 解释器 | 房子本身（毛坯） | 不管 | 管：`uv python install` |
| 第 2 层 | 虚拟环境 `.venv` | 给这个项目单独隔出的一间房 | 不管（要靠 `python -m venv`） | 管：`uv venv` |
| 第 3 层 | 依赖包 | 房间里的家具 | 管：`pip install` | 管：`uv pip install` / `uv add` / `uv sync` |

**为什么要「一间房」**：A 项目要 `pymupdf 1.23`，B 项目要 `pymupdf 1.25`，装在一起必然打架。`.venv` 就是每个项目各自的一间房，互不影响。

**pip 的隐患**：它默认往「当前激活的环境」里塞包。没建环境、也没激活时，包会装进全局 Python，把系统环境搞乱，而且很难回滚。
**uv 的较真**：它宁可直接报错，也不偷偷装进全局 —— 这正是下面第一个报错的由来。

---

## 2. 我实际遇到的三个报错，逐条拆开看

### 报错一：还没建环境就装包

```
$ uv pip install -r requirements.txt
error: No virtual environment found; run `uv venv` to create an environment,
       or pass `--system` to install into a non-virtual environment
```

- **原因**：目录下还没有 `.venv`，uv 找不到「房间」，拒绝往全局塞家具。
- **正解**：先 `uv venv`，再装包。
- **注意**：报错里提到的 `--system` 是「我明确要装进非虚拟环境」的应急开关，**项目里不要用**。

### 报错二：Git Bash 里写了 Windows 反斜杠

```
$ .venv\Scripts\activate
bash: .venvScriptsactivate: command not found
```

- **原因**：Git Bash 是 Linux 风格 shell，`\` 是**转义字符**。`\S`、`\a` 会被直接吃掉，三个反斜杠全消失，路径被拼成了 `.venvScriptsactivate`。
- **正解**：用**正斜杠**，并且加 `source`：

```bash
source .venv/Scripts/activate
```

- **为什么 `source` 不能省**：`activate` 干的事是修改**当前 shell** 的 `PATH`。直接执行会开一个子 shell，改完就退出，父 shell 毫无变化，等于白激活。

### 报错三：把 activate 当成 uv 的子命令

```
$ uv .venv\Scripts\activate
error: unrecognized subcommand '.venvScriptsactivate'
```

两个错叠在一起了：

1. `activate` 是 **shell 脚本**，不是 uv 的命令。uv 的子命令只有 `venv` / `pip` / `run` / `add` / `sync` / `python` 这类。
2. 反斜杠又被吞掉了（同报错二）。

### 最容易懵的一点

`uv venv` 成功后打印的这句：

```
Activate with: .venv\Scripts\activate
```

这是给 **CMD / PowerShell** 看的提示，**不是给 Git Bash 的**。在 Git Bash 里必须自己翻译成 `source .venv/Scripts/activate`。看到提示照抄，就会踩报错二。

---

## 3. 正确的完整流程（可直接复制）

```bash
# 0. 进入项目根目录（uv 只在这个目录及其子目录里找 .venv）
cd /d/360MoveData/Users/Administrator/Desktop/uv/pdf2ppt

# 1. 装一份干净的 CPython，并据此创建虚拟环境
uv python install 3.12
uv venv --python 3.12

# 2. 激活（Git Bash 专用写法）
source .venv/Scripts/activate

# 3. 安装依赖
uv pip install -r requirements.txt

# 4. 验证
uv pip list
python -c "import fitz, pptx, customtkinter, requests; print('依赖 OK')"

# 5. 用完退出
deactivate
```

**为什么建议第 1 步先 `uv python install`**：截图里 `uv venv` 抓到的是 `E:\soft\anaconda3\python.exe`，也就是 conda 的 base 环境。让它用 uv 自己管理的独立 CPython，后面装包就不会跟 conda 环境纠缠。

本项目的 `requirements.txt` 共 4 个依赖：`customtkinter`、`python-pptx`、`pymupdf`、`requests`（注意 `pymupdf` 的导入名是 `fitz`）。

### 三种终端的激活写法对照

| 终端 | 激活命令 | 退出 |
|---|---|---|
| Git Bash / UCRT64 | `source .venv/Scripts/activate` | `deactivate` |
| PowerShell | `.venv\Scripts\Activate.ps1` | `deactivate` |
| CMD | `.venv\Scripts\activate.bat` | `deactivate` |

PowerShell 若报「禁止运行脚本」，先执行一次：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

---

## 4. 更省事的两种做法（推荐）

### 做法 A：全程不激活

`.venv` 已经建好的情况下，两行就够：

```bash
uv pip install -r requirements.txt
uv run python app.py
```

`uv pip` 和 `uv run` 会自动发现 `.venv`，不需要 `source`。`uv run` 还会顺手用环境里的解释器把脚本跑起来。

### 做法 B：项目化管理（有 `pyproject.toml` / `uv.lock` 时）

```bash
uv add <包名>       # 加依赖，同时更新 pyproject.toml 与 uv.lock
uv sync             # 按锁文件还原出完全一致的环境
uv run python app.py
```

### 判断口诀

> 命令以 **`uv` 开头** → 不用激活。
> 命令是 **`python` / `pip` 本身** → 必须激活，否则跑到全局去了。

---

## 5. uv 与 pip 的区别速查

| 维度 | uv | pip |
|---|---|---|
| 定位 | 一体化工具：管 Python 版本、建环境、解析依赖、锁版本 | 只负责「装包」这一件事 |
| 建环境 | `uv venv` | 无此能力，需 `python -m venv .venv` |
| 装依赖 | `uv pip install -r requirements.txt`、`uv add`、`uv sync` | `pip install -r requirements.txt` |
| 是否需要激活 | `uv pip` / `uv run` 自动找 `.venv`，可不激活 | 通常必须激活，否则装进全局 |
| 锁文件 | 内置 `uv.lock`，`uv sync` 可精确复现 | 无原生锁文件，需 `pip freeze` 或 pip-tools 手工维护 |
| 管 Python 解释器 | `uv python install 3.12` 自己下载 | 管不了，得靠 conda / pyenv |
| 速度与磁盘 | Rust 实现，并行下载 + 全局缓存硬链接复用，快一个量级 | 纯 Python，缓存复用弱 |
| 兼容性 | `uv pip` 参数与 pip 基本一致，可直接替换 | 生态标准，最通用 |

### 三句大白话

1. **uv 是工具箱，pip 是其中一把螺丝刀。** 除了装包，uv 还管建环境、管 Python 版本、管锁文件。
2. **`uv pip` 是工具箱里那把「长得和 pip 一模一样」的螺丝刀。** 老脚本里的 `pip install -r requirements.txt` 基本可以原样换成 `uv pip install -r requirements.txt`，只是快很多。
3. **真正的升级是 `uv.lock` + `uv sync`。** `requirements.txt` 只写了个大概范围（如 `>=1.23.8`），换台电脑装出来可能不一样；锁文件把每个包的精确版本钉死，才能让「我这能跑」变成「谁拿去都能跑」。

---

## 6. 常见场景命令速查

| 想做的事 | pip 路线 | uv 路线 | uv 路线要激活吗 |
|---|---|---|---|
| 建虚拟环境 | `python -m venv .venv` | `uv venv` | 否 |
| 指定 Python 版本建环境 | 需先自己装好对应版本 | `uv python install 3.12` + `uv venv --python 3.12` | 否 |
| 按 requirements 装依赖 | `pip install -r requirements.txt` | `uv pip install -r requirements.txt` | 否 |
| 装单个包 | `pip install requests` | `uv pip install requests` 或 `uv add requests` | 否 |
| 看已装的包 | `pip list` | `uv pip list` | 否 |
| 跑脚本 | `python app.py` | `uv run python app.py` | 否 |
| 直接跑 `python` / `pip` | 必须先激活 | 必须先激活 | 是 |
| 退出环境 | `deactivate` | `deactivate` | — |

---

## 7. 自查与常见疑问

**怎么确认包到底装哪了？**

```bash
python -c "import sys; print(sys.executable)"
which python
```

路径里带 `.venv` 就对了；指向 `E:\soft\anaconda3` 或系统 Python，说明没激活、装错地方了。

**又报 `No virtual environment found` 怎么办？**
按顺序查三件事：当前目录是不是项目根目录；`.venv` 是不是被删了或改名了；环境变量 `VIRTUAL_ENV` 是不是指到了别处。都不行就重建：`uv venv`。

**已经激活了，还需要 `uv run` 吗？**
不需要，但用了也没坏处 —— `uv run` 会优先使用 `.venv`，行为一致，团队里统一用它能少踩坑。

**能不能混用 pip 和 uv？**
可以，`uv pip` 和 `pip` 操作的是同一个 `.venv`。但**激活后**再敲 `pip` 才安全；不激活时一律用 `uv pip`，避免误装全局。

**`uv venv` 会不会覆盖已有环境？**
会提示环境已存在，不会悄悄清空依赖。想彻底重建，手动删掉项目内的 `.venv` 再执行 `uv venv`（只删项目目录里的这一个文件夹，别碰其他路径）。

---

## 8. 一页速记

1. **先 `uv venv`，再装包** —— 没有房间就别搬家具。
2. **Git Bash 一律用正斜杠 + `source`** —— 反斜杠会被转义吃掉。
3. **`activate` 不是 uv 命令** —— 它是给 shell 执行的脚本。
4. **uv 开头的命令可不激活，`python` / `pip` 必须激活。**
5. **想长期可复现，就上 `uv add` + `uv sync` + `uv.lock`。**

---

*整理自实际排查记录：2026-11-13，`pdf2ppt` 项目，uv 0.x / CPython 3.12 / Windows Git Bash。*
