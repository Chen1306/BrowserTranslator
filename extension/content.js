// content.js — 整页翻译核心：提取、批量翻译、替换式改写、还原、SPA 监听

const BATCH = 20;
const state = { translated: false };
let settings = { dual: false, ignoredSites: [] };
const cache = new Map(); // 原文 → 译文（会话级缓存）

init();

async function init() {
  settings = await chrome.storage.local.get({ dual: false, ignoredSites: [] });
  if (settings.ignoredSites.includes(location.hostname)) return; // 忽略站点
  applyDualClass();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dual) {
      settings.dual = changes.dual.newValue;
      applyDualClass();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'translate-page') {
      toggleTranslate().then(sendResponse);
      return true; // 异步响应
    }
  });

  // SPA 动态内容：300ms 节流增量翻译
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(onDomChange, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 临时验证钩子：按 F9 翻译/还原（页面 CSP 会拦截注入脚本，故改用按键；步骤 5 接入正式入口后可移除）
  console.log('[BT] content script 已加载');
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F9') {
      console.log('[BT] F9 触发');
      toggleTranslate().then((r) => console.log('[BT] 结果', r)).catch((err) => console.error('[BT] 异常', err));
    }
  });
}

function applyDualClass() {
  document.documentElement.classList.toggle('bt-dual', !!settings.dual);
}

// —— 翻译 / 还原切换 ——
async function toggleTranslate() {
  if (state.translated) {
    restore();
    return { ok: true, action: 'restored' };
  }
  const res = await translatePage();
  return res;
}

async function translatePage() {
  const res = await translateNodes(collectTextNodes(document.body));
  if (!res.ok) return res;
  state.translated = true;
  document.documentElement.dataset.btTranslated = '1';
  return { ok: true, action: 'translated', count: res.count };
}

function restore() {
  document.querySelectorAll('.bt-trans[data-bt]').forEach((span) => {
    span.replaceWith(document.createTextNode(span.dataset.original));
  });
  delete document.documentElement.dataset.btTranslated;
  state.translated = false;
}

// —— 文本提取（跳过免翻区域与已翻译标记）——
function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('script, style, pre, textarea, input, [contenteditable], [data-bt]')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// —— 批量翻译并应用（批次间限 3 路并发：LLM 单请求生成耗时，并发显著提速）——
async function translateNodes(nodes) {
  const pairs = nodes
    .map((node) => ({ node, text: node.textContent.trim() }))
    .filter((p) => !cache.has(p.text));
  const batches = [];
  for (let i = 0; i < pairs.length; i += BATCH) batches.push(pairs.slice(i, i + BATCH));
  let allOk = true;
  await mapLimit(batches, 3, async (batch) => {
    const res = await chrome.runtime.sendMessage({ type: 'translate', texts: batch.map((b) => b.text) });
    if (!res.ok) {
      allOk = false;
      return; // 失败批次保留原文
    }
    batch.forEach((b, idx) => cache.set(b.text, res.texts[idx]));
  });
  pairs.forEach((p) => applyTranslation(p.node, cache.get(p.text)));
  return { ok: allOk, count: pairs.length };
}

// 并发受限的遍历
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function applyTranslation(node, translated) {
  const span = document.createElement('span');
  span.className = 'bt-trans';
  span.dataset.bt = '1';
  span.dataset.original = node.textContent; // 原文完整保留（含空白），供还原与双语显示
  span.textContent = translated;
  node.replaceWith(span);
}

// —— SPA 增量翻译 ——
async function onDomChange() {
  if (!state.translated) return; // 未翻译时不处理新增内容
  await translateNodes(collectTextNodes(document.body));
}
