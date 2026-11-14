'use strict';

// Application state is intentionally plain data. Feature modules own their schemas.
const state = {
  section: 'artist', mode: 'online', model: 'V5', kind: 'all', knowledgeTab: 'basic', artistSource: 'korean',
  page: 0, online: null, onlineTask: null, onlineError: false, hasOnline: false,
  personal: [], personalError: false, packs: [], pack: null, packRows: [],
  packMessage: '', importing: false, importingRemote: false,
  // Filled by app.js after its cached gallery-index reader is available.
  galleryPacks: [],
  artistGroup: 'all', galleryFocus: false, galleryColumns: 4, artistShuffle: 0, artistOrder: 'name',
  artistPostBand: 'all', koreanPostBands: [],
  characterFilters: {},
  koreanPack: 'all', korean: null, koreanTask: null, koreanError: false, koreanChecking: false, koreanStatus: '',
  tagGalleryReturn: null,
};

// Theme preference and the small storage utilities shared by feature modules.
const themeStorageKey = 'pocket-theme-v1';
const themeChoices = new Map([
  ['original', { name: '原版蓝灰', paper: '#f1f3f5' }],
  ['blush', { name: '心动粉蓝', paper: '#fdf8fa' }],
  ['amber', { name: '暖阳薄荷', paper: '#fefcf5' }],
  ['academy', { name: '学院深蓝', paper: '#f6f9fe' }],
  ['rose', { name: '玫瑰红金', paper: '#fdf7f8' }],
  ['emerald', { name: '祖母绿影', paper: '#f4fbf8' }],
  ['violet', { name: '星夜紫金', paper: '#f8f6fe' }],
  ['macaron', { name: '马卡龙粉', paper: '#fef7fc' }],
  ['night', { name: '暗夜冰蓝', paper: '#0f172a' }],
  ['pearl', { name: '珍珠冰白', paper: '#f8fafc' }],
  ['prism', { name: '全息棱镜', paper: '#faf7ff' }],
]);

function readSavedTheme() {
  try {
    const saved = localStorage.getItem(themeStorageKey);
    return themeChoices.has(saved) ? saved : 'original';
  } catch {
    return 'original';
  }
}

function applyTheme(value, { persist = false } = {}) {
  const theme = themeChoices.has(value) ? value : 'original';
  const { name, paper } = themeChoices.get(theme);
  document.documentElement.dataset.theme = theme;
  const picker = document.getElementById('theme-trigger');
  if (picker) picker.textContent = name;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = paper;
  if (persist) {
    try { localStorage.setItem(themeStorageKey, theme); }
    catch { /* The selected palette still applies for this session. */ }
  }
}

applyTheme(readSavedTheme());

function readJsonStorageEntry(key) {
  const raw = localStorage.getItem(key);
  return { present: raw !== null, value: raw === null ? null : JSON.parse(raw) };
}

function readJsonStorage(key) {
  const entry = readJsonStorageEntry(key);
  return entry.present ? entry.value : null;
}

function readJsonStorageOr(key, fallback) {
  try {
    const entry = readJsonStorageEntry(key);
    return entry.present ? entry.value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function debounce(callback, delay) {
  let timer = 0;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      callback(...args);
    }, delay);
  }
  return debounced;
}

// The dialog and Android bridge are available by the time a screen requests copy.
async function copy(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return;
  const revision = screenRevision;
  try {
    if (window.Pocket) {
      if (await native('copy', text, 4500) !== true) throw new Error('系统未确认复制。');
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast('已复制');
  } catch {
    if (revision !== screenRevision) return;
    if (!screen.open) openScreen('手动复制');
    body.querySelector('.copy-fallback')?.remove();
    const fallback = node('section', 'copy-fallback');
    const field = node('textarea', '');
    field.readOnly = true;
    field.value = text;
    field.setAttribute('aria-label', '待复制内容');
    fallback.append(node('p', '', '系统未能复制。可长按文本，选择要复制的内容。'), field);
    body.append(fallback);
    field.focus();
    field.select();
    fallback.scrollIntoView({ block: 'nearest' });
  }
}

window.PocketApp = window.PocketApp || {};
window.PocketApp.core = Object.freeze({
  state, readSavedTheme, applyTheme,
  readJsonStorageEntry, readJsonStorage, readJsonStorageOr, writeJsonStorage,
  debounce, copy,
});
