// ui.js — 选择窗（步骤 4）；悬浮按钮/划词/快捷键在步骤 5 接入

initUI();

async function initUI() {
  const s = await getSettings();
  if (s.ignoredSites.includes(location.hostname)) return; // 忽略站点
  buildPanel();
  // 点击面板外关闭
  document.addEventListener('mousedown', (e) => {
    if (panel.style.display !== 'none' && !panel.contains(e.target)) closePanel();
  });
  // 临时验证钩子：按 F10 打开选择窗（步骤 5 接入悬浮按钮后可移除）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F10') openPanel();
  });
}

let panel = null;

function getSettings() {
  return chrome.runtime.sendMessage({ type: 'get-settings' });
}

function buildPanel() {
  panel = document.createElement('div');
  panel.id = 'bt-panel';
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
    const map = { 'bt-base-url': 'baseUrl', 'bt-api-key': 'apiKey', 'bt-model': 'model' };
    const key = map[e.target.id];
    if (key) {
      getSettings().then((s) => {
        s.llm[key] = e.target.value;
        save({ llm: s.llm });
      });
    }
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
