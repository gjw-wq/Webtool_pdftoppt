/* ==========================================================
   PDF2PPT Web · 交互逻辑
   ========================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const S = {
    jid: null,
    preview: null,
    view: 'pptx',
    pagePptx: 1,
    pagePdf: 1,
    zoom: 1,
    logCount: 0,
    localLines: 0,
    polling: null,
    busy: false,
    file: null,
    ratio: '16:9',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeFont(name) {
    return /^[\w\s\-]+$/.test(name || '') ? name : 'Microsoft YaHei';
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  function setStatus(state, text) {
    $('statusChip').dataset.state = state;
    $('statusText').textContent = text;
  }

  function setBusy(busy) {
    S.busy = busy;
    const btn = $('convertBtn');
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
    btn.querySelector('span').textContent = busy ? '转换中…' : '开始转换';
    $('demoBtn').disabled = busy;
    $('progressArea').hidden = !busy;
  }

  // ------------------------------------------------------ 主题
  function currentTheme() { return document.documentElement.dataset.theme; }
  $('themeToggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pdf2ppt-theme', next); } catch (e) { /* noop */ }
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  });

  // ------------------------------------------------------ 文件选择
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toast('只支持 .pdf 文件', 'error'); return; }
    if (file.size > 100 * 1024 * 1024) { toast('文件超过 100 MB 限制', 'error'); return; }
    S.file = file;
    $('fileName').textContent = file.name;
    $('fileSize').textContent = humanSize(file.size) + ' · 待转换';
    $('fileCard').hidden = false;
    $('dropzone').hidden = true;
  }

  function clearFile() {
    S.file = null;
    $('fileInput').value = '';
    $('fileCard').hidden = true;
    $('dropzone').hidden = false;
  }

  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('dropzone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
  });
  $('fileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
  $('clearFile').addEventListener('click', clearFile);

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((evt) => dz.addEventListener(evt, (e) => {
    e.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => dz.addEventListener(evt, (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });

  // ------------------------------------------------------ 设置项
  $('toggleToken').addEventListener('click', () => {
    const input = $('tokenInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.querySelectorAll('.ratio-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ratio-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      S.ratio = btn.dataset.ratio;
    });
  });

  $('console'); // ensure node exists
  $('toggleConsole').addEventListener('click', () => {
    const c = $('console');
    c.classList.toggle('collapsed');
    $('toggleConsole').textContent = c.classList.contains('collapsed') ? '展开' : '收起';
  });
  $('clearLog').addEventListener('click', () => {
    $('logBody').innerHTML = '';
    S.localLines = 0;
    $('logCount').textContent = '0 条';
  });

  // ------------------------------------------------------ 日志
  function appendLog(line) {
    const body = $('logBody');
    const div = document.createElement('div');
    const cls = line.level === 'ERROR' ? ' error'
      : (/完成|成功|已就绪/.test(line.msg) ? ' success' : '');
    div.className = 'log-line' + cls;
    div.innerHTML = '<span class="lt">' + esc(line.t) + '</span>'
      + '<span class="lv">' + esc(line.level) + '</span>'
      + '<span class="lm">' + esc(line.msg) + '</span>';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    S.localLines += 1;
    $('logCount').textContent = S.localLines + ' 条';
  }

  function updateProgress(d) {
    $('progressStage').textContent = d.stage;
    $('progressPct').textContent = d.progress + '%';
    $('progressFill').style.width = d.progress + '%';
    $('viewerBadge').textContent = d.stage;
  }

  // ------------------------------------------------------ 任务轮询
  function startPolling() {
    S.logCount = 0;
    if (S.polling) clearInterval(S.polling);
    S.polling = setInterval(poll, 900);
    poll();
  }

  async function poll() {
    if (!S.jid) return;
    try {
      const res = await fetch('/api/status/' + S.jid + '?since=' + S.logCount);
      const d = await res.json();
      if (!d.ok) { stopPolling(); return; }

      if (d.logCount < S.logCount) S.logCount = 0;   // 日志被裁剪时重置
      (d.logs || []).forEach(appendLog);
      S.logCount = d.logCount;
      updateProgress(d);

      if (d.state === 'running' || d.state === 'queued') {
        setStatus('running', d.stage);
      } else if (d.state === 'done') {
        stopPolling();
        setStatus('ready', '转换完成');
        setBusy(false);
        appendLog({ t: '', level: 'INFO', msg: '任务完成，正在载入预览…' });
        await loadPreview();
        toast('转换完成，可预览并下载 PPTX');
      } else if (d.state === 'error') {
        stopPolling();
        setStatus('error', '转换失败');
        setBusy(false);
        appendLog({ t: '', level: 'ERROR', msg: d.error || '未知错误' });
        toast(d.error || '转换失败', 'error');
      }
    } catch (e) {
      appendLog({ t: '', level: 'ERROR', msg: '状态查询失败：' + e.message });
    }
  }

  function stopPolling() {
    if (S.polling) { clearInterval(S.polling); S.polling = null; }
  }

  // ------------------------------------------------------ 发起任务
  async function startConvert() {
    if (S.busy) return;
    if (!S.file) { toast('请先选择 PDF 文件', 'error'); return; }

    const token = $('tokenInput').value.trim();
    try {
      if ($('rememberToken').checked) localStorage.setItem('pdf2ppt-token', token);
      else localStorage.removeItem('pdf2ppt-token');
    } catch (e) { /* noop */ }

    const fd = new FormData();
    fd.append('pdf', S.file);
    fd.append('token', token);
    fd.append('ratio', S.ratio);
    fd.append('removeWatermark', $('removeWatermark').checked ? '1' : '0');
    fd.append('useCache', $('useCache').checked ? '1' : '0');

    $('logBody').innerHTML = '';
    S.localLines = 0;
    $('logCount').textContent = '0 条';
    appendLog({ t: '', level: 'INFO', msg: '提交任务：' + S.file.name });
    setBusy(true);
    setStatus('running', '提交中');

    try {
      const res = await fetch('/api/convert', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || '提交失败');
      S.jid = d.jobId;
      $('fileSize').textContent = humanSize(S.file.size) + ' · 转换中';
      startPolling();
    } catch (e) {
      setBusy(false);
      setStatus('error', '提交失败');
      appendLog({ t: '', level: 'ERROR', msg: e.message });
      toast(e.message, 'error');
    }
  }

  async function loadDemo() {
    if (S.busy) return;
    setBusy(true);
    setStatus('running', '载入示例');
    appendLog({ t: '', level: 'INFO', msg: '载入内置示例 demo.pptx…' });
    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || '示例载入失败');
      S.jid = d.jobId;
      const st = await (await fetch('/api/status/' + S.jid)).json();
      (st.logs || []).forEach(appendLog);
      updateProgress(st);
      await loadPreview();
      setBusy(false);
      setStatus('ready', '示例已就绪');
      $('fileSize').textContent = '内置示例 · 无需 Token';
      toast('示例已载入，可切换「PPTX 预览 / PDF 原稿」对照查看');
    } catch (e) {
      setBusy(false);
      setStatus('error', '载入失败');
      appendLog({ t: '', level: 'ERROR', msg: e.message });
      toast(e.message, 'error');
    }
  }

  $('convertBtn').addEventListener('click', startConvert);
  $('demoBtn').addEventListener('click', loadDemo);

  // ------------------------------------------------------ 预览数据
  async function loadPreview() {
    const res = await fetch('/api/preview/' + S.jid);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || '预览载入失败');

    S.preview = d;
    S.pagePptx = 1;
    S.pagePdf = 1;
    S.zoom = 1;
    $('emptyState').hidden = true;
    $('downloadBtn').disabled = false;
    $('downloadBtn').onclick = () => { window.location.href = '/api/download/' + S.jid; };
    $('viewerInfo').textContent = '预览按 PPTX 内真实坐标与字号重建 · ' + d.slideCount + ' 页幻灯片 · ' + d.pdfPageCount + ' 页原稿';

    if (!d.pdfPageCount) {
      $('tabPdf').disabled = true;
      $('tabPdf').title = '该任务没有 PDF 原稿';
    } else {
      $('tabPdf').disabled = false;
      $('tabPdf').title = '';
    }
    setView('pptx');
  }

  // ------------------------------------------------------ 形状渲染
  function shapeHtml(sh) {
    const pos = 'left:' + sh.x + '%;top:' + sh.y + '%;width:' + sh.w + '%;height:' + sh.h + '%;';
    if (sh.type === 'image') {
      return '<div class="shape shape-image" style="' + pos + '"><img src="' + esc(sh.src) + '" alt=""></div>';
    }
    if (sh.type === 'table') {
      const rows = (sh.rows || []).map((row) =>
        '<tr>' + row.map((cell) => '<td>' + esc(cell) + '</td>').join('') + '</tr>'
      ).join('');
      return '<div class="shape shape-table" style="' + pos + 'font-size:' + sh.size + 'px">'
        + '<table>' + rows + '</table></div>';
    }
    const paras = (sh.paragraphs || []).map((p) =>
      '<p style="font-size:' + p.size + 'px;font-weight:' + (p.bold ? 700 : 400)
      + ';font-style:' + (p.italic ? 'italic' : 'normal')
      + ';color:' + esc(p.color) + ';text-align:' + esc(p.align)
      + ';font-family:\'' + safeFont(p.font) + '\',\'Microsoft YaHei\',sans-serif">'
      + esc(p.text) + '</p>'
    ).join('');
    const pad = (sh.pad || [4, 8, 4, 8]).map((v) => v + 'px').join(' ');
    if (sh.type === 'rect') {
      return '<div class="shape shape-rect" style="' + pos
        + 'background:' + esc(sh.fill || 'transparent') + ';'
        + (sh.radius ? 'border-radius:' + sh.radius + 'px;' : '')
        + (paras ? 'padding:' + pad + ';' : '')
        + '">' + paras + '</div>';
    }
    return '<div class="shape shape-text ' + (sh.wrap ? 'wrap' : '') + '" style="'
      + pos + 'padding:' + pad + '">' + paras + '</div>';
  }

  function renderSlide(n) {
    const slide = S.preview.slides[n - 1];
    const c = S.preview.canvas;
    const host = $('slideHost');
    const bg = slide && slide.background ? esc(slide.background) : 'var(--paper)';
    host.innerHTML = '<div class="slide-canvas" id="slideCanvas" style="width:'
      + c.w + 'px;height:' + c.h + 'px;background:' + bg + '">'
      + (slide ? slide.shapes.map(shapeHtml).join('') : '') + '</div>';
    host.hidden = false;
    $('pdfSheet').hidden = true;
  }

  function renderPdf(n) {
    const page = S.preview.pdfPages[n - 1];
    if (!page) return;
    $('pdfImage').src = page.src;
    $('pdfSheet').hidden = false;
    $('slideHost').hidden = true;
  }

  // ------------------------------------------------------ 缩放 / 翻页
  function pageSize() {
    if (!S.preview) return { w: 1280, h: 720 };
    if (S.view === 'pptx') return S.preview.canvas;
    const p = S.preview.pdfPages[S.pagePdf - 1];
    return p ? { w: p.w, h: p.h } : S.preview.canvas;
  }

  function fitScale() {
    const stage = $('stage');
    const p = pageSize();
    const availW = Math.max(200, stage.clientWidth - 64);
    const availH = Math.max(160, stage.clientHeight - 56);
    return Math.min(availW / p.w, availH / p.h);
  }

  function applyScale() {
    if (!S.preview) return;
    const scale = Math.max(0.05, fitScale() * S.zoom);
    const p = pageSize();
    const target = S.view === 'pptx' ? $('slideHost') : $('pdfSheet');
    target.style.width = Math.round(p.w * scale) + 'px';
    target.style.height = Math.round(p.h * scale) + 'px';
    if (S.view === 'pptx') {
      const cv = $('slideCanvas');
      if (cv) cv.style.transform = 'scale(' + scale + ')';
    }
    // 显示相对「适应窗口」的倍数，而不是相对原始像素的绝对比例
    $('zoomLabel').textContent = S.zoom === 1 ? '适应' : Math.round(S.zoom * 100) + '%';
  }

  function pageInfo() {
    if (!S.preview) return { page: 0, count: 0 };
    return S.view === 'pptx'
      ? { page: S.pagePptx, count: S.preview.slideCount }
      : { page: S.pagePdf, count: S.preview.pdfPageCount };
  }

  function render() {
    if (!S.preview) return;
    const { page } = pageInfo();
    if (S.view === 'pptx') renderSlide(page);
    else renderPdf(page);
    applyScale();
    updatePager();
  }

  function updatePager() {
    const { page, count } = pageInfo();
    $('pageLabel').textContent = count ? page + ' / ' + count : '— / —';
    $('prevPage').disabled = !count || page <= 1;
    $('nextPage').disabled = !count || page >= count;
  }

  function goto(delta) {
    if (!S.preview) return;
    const { count } = pageInfo();
    if (!count) return;
    const next = (S.view === 'pptx' ? S.pagePptx : S.pagePdf) + delta;
    if (next < 1 || next > count) return;
    if (S.view === 'pptx') S.pagePptx = next; else S.pagePdf = next;
    render();
  }

  function setView(view) {
    if (view === 'pdf' && (!S.preview || !S.preview.pdfPageCount)) {
      toast('该任务没有可对照的 PDF 原稿', 'error');
      return;
    }
    S.view = view;
    $('tabPptx').classList.toggle('active', view === 'pptx');
    $('tabPdf').classList.toggle('active', view === 'pdf');
    $('tabPptx').setAttribute('aria-selected', view === 'pptx');
    $('tabPdf').setAttribute('aria-selected', view === 'pdf');
    S.zoom = 1;
    render();
  }

  $('tabPptx').addEventListener('click', () => setView('pptx'));
  $('tabPdf').addEventListener('click', () => setView('pdf'));
  $('prevPage').addEventListener('click', () => goto(-1));
  $('nextPage').addEventListener('click', () => goto(1));
  $('zoomIn').addEventListener('click', () => { S.zoom = Math.min(3, S.zoom * 1.2); applyScale(); });
  $('zoomOut').addEventListener('click', () => { S.zoom = Math.max(0.3, S.zoom / 1.2); applyScale(); });
  $('zoomFit').addEventListener('click', () => { S.zoom = 1; applyScale(); });

  document.addEventListener('keydown', (e) => {
    if (!S.preview || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') goto(-1);
    if (e.key === 'ArrowRight') goto(1);
  });

  let raf = null;
  window.addEventListener('resize', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (S.preview) applyScale(); });
  });

  // ------------------------------------------------------ 初始化
  async function init() {
    try {
      const saved = localStorage.getItem('pdf2ppt-token');
      if (saved && $('rememberToken').checked) $('tokenInput').value = saved;
    } catch (e) { /* noop */ }

    try {
      const cfg = await (await fetch('/api/config')).json();
      if (cfg.hasDefaultToken) {
        $('tokenHint').textContent = '已检测到 config.py 中的 Token，此处可留空。';
        $('tokenInput').placeholder = '留空即使用 config.py 中的配置';
      }
      if (!cfg.demoAvailable) $('demoBtn').disabled = true;
    } catch (e) { /* noop */ }

    updatePager();

    // 可直接分享的示例链接：/?demo=1
    if (new URLSearchParams(location.search).get('demo') === '1') loadDemo();
  }

  init();
})();
