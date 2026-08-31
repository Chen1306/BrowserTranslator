// options.js — 设置面板：目标语言、忽略站点（改动即保存）

const targetLang = document.getElementById('target-lang');
const ignoredSites = document.getElementById('ignored-sites');
const status = document.getElementById('status');

async function load() {
  const s = await chrome.storage.local.get({ targetLang: 'zh', ignoredSites: [] });
  targetLang.value = s.targetLang;
  ignoredSites.value = s.ignoredSites.join(', ');
}

async function save() {
  await chrome.storage.local.set({
    targetLang: targetLang.value.trim() || 'zh',
    ignoredSites: ignoredSites.value.split(/[,，\s]+/).filter(Boolean)
  });
  status.textContent = '已保存';
  setTimeout(() => (status.textContent = ''), 1500);
}

targetLang.addEventListener('input', save);
ignoredSites.addEventListener('input', save);
load();
