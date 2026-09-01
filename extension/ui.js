// ui.js — 悬浮按钮、选择窗、划词浮窗（Alt+T 由 background 的 commands 转发）

const PANEL_ID = 'bt-panel';
const FAB_ID = 'bt-fab';
const TIP_ID = 'bt-tip';
let panel = null;
let fab = null;
let tip = null;
let pendingTranslate = false; // 选择窗关闭后，首次单击按钮 = 翻译当前页

initUI();

async function initUI() {
  const s = await getSettings();
  if (s.ignoredSites.includes(location.hostname)) return; // 忽略站点
  buildPanel();
  buildFab();
  buildTip();
  // 点击扩展 UI 外：关闭选择窗（并标记下次单击按钮=翻译）、隐藏划词浮窗
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest(`#${PANEL_ID}, #${FAB_ID}, #${TIP_ID}`)) {
      if (panel.style.display !== 'none') {
        closePanel();
        pendingTranslate = true;
      }
      hideTip();
    }
  });
  // 划词翻译
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest(`#${PANEL_ID}, #${FAB_ID}, #${TIP_ID}`)) return;
    const text = window.getSelection()?.toString().trim();
    if (text && text.length <= 200) showTip(e.clientX, e.clientY, text);
  });
}

function getSettings() {
  return chrome.runtime.sendMessage({ type: 'get-settings' });
}

async function translatePage() {
  try {
    return await chrome.runtime.sendMessage({ type: 'translate-page' });
  } catch {
    return { ok: false, error: '内容脚本未响应' };
  }
}

// —— 悬浮按钮：可拖动；单击 = 开/关选择窗，关闭选择窗后首次单击 = 翻译 ——
function buildFab() {
  fab = document.createElement('div');
  fab.id = FAB_ID;
  fab.textContent = '译';
  fab.style.left = `${window.innerWidth - 70}px`;
  fab.style.top = '80px';
  document.documentElement.appendChild(fab);

  let drag = null;
  fab.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { ox: e.clientX - fab.offsetLeft, oy: e.clientY - fab.offsetTop, sx: e.clientX, sy: e.clientY, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
    fab.style.left = `${Math.min(Math.max(0, e.clientX - drag.ox), window.innerWidth - 44)}px`;
    fab.style.top = `${Math.min(Math.max(0, e.clientY - drag.oy), window.innerHeight - 44)}px`;
  });
  window.addEventListener('mouseup', async () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) return; // 拖动不算单击
    if (panel.style.display !== 'none') {
      closePanel();
      return;
    }
    if (pendingTranslate) {
      pendingTranslate = false;
      fab.textContent = '…';
      const res = await translatePage();
      if (res?.ok) {
        fab.textContent = '译';
      } else {
        fab.textContent = '✕'; // 翻译失败提示
        setTimeout(() => (fab.textContent = '译'), 1500);
      }
      return;
    }
    openPanel();
  });
}

// —— 选择窗 ——
function buildPanel() {
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="bt-panel-title">翻译设置</div>
    <div class="bt-field">
      <div class="bt-label">引擎</div>
      <label><input type="radio" name="bt-engine" value="free"> 免费接口</label>
      <label><input type="radio" name="bt-engine" value="llm"> LLM</label>
    </div>
    <div class="bt-llm">
      <input id="bt-base-url" placeholder="API 地址" spellcheck="false">
      <input id="bt-api-key" type="password" placeholder="API Key">
      <input id="bt-model" placeholder="模型名" spellcheck="false">
    </div>
    <div class="bt-field">
      <div class="bt-label">显示模式</div>
      <label><input type="radio" name="bt-mode" value="replace"> 替换</label>
      <label><input type="radio" name="bt-mode" value="dual"> 双语</label>
    </div>`;
  document.documentElement.appendChild(panel);
  panel.addEventListener('change', (e) => {
    if (e.target.name === 'bt-engine') {
      save({ engine: e.target.value });
      panel.querySelector('.bt-llm').style.display = e.target.value === 'llm' ? '' : 'none';
    } else if (e.target.name === 'bt-mode') {
      save({ dual: e.target.value === 'dual' });
    }
  });
  panel.addEventListener('input', (e) => {
    if (!e.target.id.startsWith('bt-')) return;
    save({ llm: { // 直接取面板当前值，避免异步读-改-写互相覆盖
      baseUrl: panel.querySelector('#bt-base-url').value.trim(),
      apiKey: panel.querySelector('#bt-api-key').value,
      model: panel.querySelector('#bt-model').value.trim()
    } });
  });
  return panel;
}

async function openPanel() {
  if (!panel) buildPanel();
  const s = await getSettings();
  panel.querySelector('[name=bt-engine][value="' + s.engine + '"]').checked = true;
  panel.querySelector('[name=bt-mode][value="' + (s.dual ? 'dual' : 'replace') + '"]').checked = true;
  panel.querySelector('.bt-llm').style.display = s.engine === 'llm' ? '' : 'none';
  panel.querySelector('#bt-base-url').value = s.llm.baseUrl;
  panel.querySelector('#bt-api-key').value = s.llm.apiKey;
  panel.querySelector('#bt-model').value = s.llm.model;
  panel.style.display = 'block';
}

function closePanel() {
  if (panel) panel.style.display = 'none';
}

function save(partial) {
  return chrome.storage.local.set(partial);
}

// —— 划词浮窗 ——
function buildTip() {
  tip = document.createElement('div');
  tip.id = TIP_ID;
  tip.style.display = 'none';
  document.documentElement.appendChild(tip);
}

async function showTip(x, y, text) {
  tip.textContent = '翻译中…';
  tip.style.display = 'block';
  tip.style.left = `${Math.min(x, Math.max(0, window.innerWidth - 340))}px`;
  tip.style.top = `${Math.min(y + 15, Math.max(0, window.innerHeight - 60))}px`;
  const res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text] });
  if (tip.style.display === 'none') return; // 期间已被关闭
  tip.textContent = res.ok ? res.texts[0] : `翻译失败：${res.error}`;
}

function hideTip() {
  if (tip) tip.style.display = 'none';
}
