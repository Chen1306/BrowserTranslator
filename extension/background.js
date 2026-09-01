// background.js — 翻译管线：首选引擎 → 降级引擎，统一消息入口

const DEFAULTS = {
  engine: 'free',                        // 首选引擎：'free' | 'llm'（选择窗设定）
  dual: false,                           // 显示模式：false=替换 | true=双语
  llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
  targetLang: 'zh',
  ignoredSites: []
};

const LANG_NAMES = { zh: '中文', en: 'English', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };
const TIMEOUT = 10000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'translate') {
    translate(msg.texts).then(sendResponse);
    return true; // 异步 sendResponse
  }
  if (msg.type === 'get-settings') {
    getSettings().then(sendResponse);
    return true;
  }
});

function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

// Alt+T：转发翻译指令到当前标签页的内容脚本
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'translate-page') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'translate-page' }).catch(() => {});
  });
});

async function translate(texts) {
  const settings = await getSettings();
  const order = settings.engine === 'llm' ? ['llm', 'free'] : ['free', 'llm'];
  const errors = [];
  for (const engine of order) {
    try {
      const out = engine === 'llm'
        ? await translateByLLM(texts, settings)
        : await translateByFree(texts, settings);
      return { ok: true, texts: out };
    } catch (e) {
      const err = e.message || String(e);
      errors.push(`${engine}: ${err}`);
      console.warn(`[${engine}] 翻译失败，降级：`, err);
    }
  }
  return { ok: false, error: `翻译失败：${errors.join('；')}` };
}

// —— LLM provider：OpenAI 兼容 chat/completions ——
async function translateByLLM(texts, settings) {
  const { baseUrl, apiKey, model } = settings.llm;
  if (!apiKey) throw new Error('未配置 LLM API Key');
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: `你是翻译引擎。将输入 JSON 数组中的每一项翻译成${LANG_NAMES[settings.targetLang] || settings.targetLang}。只返回一个与输入等长同序的 JSON 字符串数组，不要任何解释或多余内容。` },
        { role: 'user', content: JSON.stringify(texts) }
      ]
    })
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const msg = detail?.error?.message || detail?.message || '';
    throw new Error(`LLM HTTP ${res.status}${msg ? `：${String(msg).slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const out = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('LLM 返回格式不符');
  return out;
}

// —— 免费 provider：MyMemory（无需 Key；匿名日配额约 5000 字符，需指定源语言）——
async function translateByFree(texts, settings) {
  const to = settings.targetLang === 'zh' ? 'zh-CN' : settings.targetLang;
  // 源语言启发式：含中日韩字符视为中文，否则按英文（覆盖常见英译中；其他源语言请用 LLM 引擎）
  const from = texts.some((t) => /[぀-ヿ一-鿿]/.test(t)) ? 'zh' : 'en';
  // 超长段落按 400 字符切块（免费接口单查询上限 500 字符），并发 3 + 429 退避
  const plans = [];
  texts.forEach((t, i) => {
    for (const c of chunkText(t, 400)) plans.push({ i, text: c });
  });
  const outs = await mapLimit(plans, 3, async ({ i, text }) => {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const data = await fetchJsonWithRetry(url);
    if (data.quotaFinished) throw new Error('MyMemory 当日配额已用完');
    const out = data.responseData?.translatedText;
    if (!out) throw new Error('MyMemory 返回格式不符');
    return { i, out };
  });
  const grouped = texts.map(() => []);
  outs.forEach((o) => grouped[o.i].push(o.out));
  return grouped.map((parts) => parts.join(' '));
}

// 单段超限时按空格断点切分，无断点则硬切
function chunkText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

// 请求 JSON，429/5xx 时退避 3s 重试两次；最终失败附接口真实提示
async function fetchJsonWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(url);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(3000);
      continue;
    }
    if (res.status === 429) {
      const hint = await res.json().catch(() => null);
      const msg = hint?.responseData?.translatedText || hint?.responseDetails || '';
      throw new Error(`MyMemory HTTP 429${msg ? '：' + msg.slice(0, 80) : ''}`);
    }
    throw new Error(`MyMemory HTTP ${res.status}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 并发受限的 map：同一时刻最多 limit 个请求在途
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
