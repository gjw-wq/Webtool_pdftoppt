/* 截图脚本：通过 CDP 让 Edge 真实渲染工作台的各个关键状态。
 * 前置：Web 服务在 5000 端口；Edge 以 --remote-debugging-port=9222 启动。
 * 示例素材为项目自带的 4 页「PDF → 可编辑 PPTX」调研汇报（自有内容）。
 */
const fs = require('fs');
const path = require('path');

const OUT = 'D:/360MoveData/Users/Administrator/Desktop/uv/pdf2ppt/screenshots';
const BASE = 'http://127.0.0.1:5000';
fs.mkdirSync(OUT, { recursive: true });

let seq = 0;
let ws;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expression, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expression)) return; } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error('等待超时: ' + label);
}

function save(name, base64) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  console.log('OK  ' + name + '  ' + fs.statSync(file).size + ' bytes');
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  save(name, r.data);
}

/* 只截幻灯片画布本身：用于 README 的「转换后」效果示意图 */
async function shotElement(selector, name, scale = 2) {
  const raw = await evaluate(
    '(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');'
    + 'if(!e)return "";var r=e.getBoundingClientRect();'
    + 'return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()'
  );
  const r = JSON.parse(raw || '{}');
  if (!r.w || !r.h) throw new Error('元素尺寸为空: ' + selector);
  const res = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h), scale }
  });
  save(name, res.data);
  console.log('     ' + Math.round(r.w) + 'x' + Math.round(r.h) + ' @' + scale + 'x');
}

/* 直接取服务渲染的 PDF 第 1 页 PNG：用于 README 的「转换前」原稿图 */
async function shotPdfOriginal() {
  const src = await evaluate("document.getElementById('pdfImage').getAttribute('src')");
  const res = await fetch(BASE + src);
  if (!res.ok) throw new Error('PDF 原稿资源获取失败 ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(OUT, '转换前.png');
  fs.writeFileSync(file, buf);
  console.log('OK  转换前.png  ' + buf.length + ' bytes  (' + src + ')');
}

const PREVIEW_READY = "document.getElementById('viewerInfo').textContent.indexOf('页幻灯片') >= 0";
const PDF_READY = "document.getElementById('pdfImage').naturalWidth > 0";

async function open(url, ready) {
  await send('Page.navigate', { url });
  await waitFor("document.readyState === 'complete'", '页面加载');
  await waitFor(ready, '内容渲染');
  await sleep(4200); // 等「示例已载入」浮层自动消失，交付图保持干净
  await waitFor("!document.getElementById('toast').classList.contains('show')", '浮层消失');
  await sleep(500);  // 等图片与字体稳定
}

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list', { headers: { Host: '127.0.0.1:9222' } })).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到浏览器页面');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true }); // 确保拿到最新 CSS
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });

  // 1. 浅色主题 · 工作台主视图 · PPTX 第 1 页
  await open(BASE + '/?demo=1&theme=light', PREVIEW_READY);
  await shot('01-workbench-light.png');
  // 同一页的纯画布截图，作为「可编辑 PPTX 重建效果」示意
  await shotElement('#slideCanvas', '转换后.png');

  // 2. 浅色主题 · 翻到第 3 页，展示不同版式的重建效果
  await evaluate("document.getElementById('nextPage').click(); document.getElementById('nextPage').click(); true");
  await sleep(600);
  await shot('02-slide-page3-light.png');

  // 3. 深色主题 · 工作台主视图
  await open(BASE + '/?demo=1&theme=dark', PREVIEW_READY);
  await shot('03-workbench-dark.png');

  // 4. 深色主题 · PDF 原稿对照（第 1 页存为对比图，再翻到第 2 页截界面）
  await evaluate("document.getElementById('tabPdf').click(); true");
  await waitFor(PDF_READY, 'PDF 原稿图片');
  await shotPdfOriginal();
  await evaluate("document.getElementById('nextPage').click(); true");
  await sleep(700);
  await shot('04-pdf-source-dark.png');

  // 5. 初始空状态 · 上传前
  await open(BASE + '/?theme=light', "document.getElementById('emptyState').hidden === false");
  await sleep(500);
  await shot('05-empty-state-light.png');

  const state = await evaluate("JSON.stringify({theme:document.documentElement.dataset.theme, badge:document.getElementById('viewerBadge').textContent})");
  console.log('FINAL ' + state);
  ws.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
