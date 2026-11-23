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

// Keep the visual dictionary in its own store so replacing it leaves personal entries intact.
(function () {
  const format = 'nai-pocket-visual-tags';
  const maxBytes = 20 * 1024 * 1024;
  const fields = ['tag_raw', 'tag_copy', 'group', 'subcategory', 'meaning_zh',
    'usage_zh', 'recommended', 'aliases', 'source'];

  let database;
  let cachedCatalog;
  let loading;
  let catalogQueue = Promise.resolve();

  function tagKey(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[\s_]+/g, ' ').trim();
  }

  function buildCatalog(data, { builtIn = false } = {}) {
    if (data?.format !== format || data.schema_version !== 1) {
      throw new Error('请选择画面标签字典的 visual-tags.json 文件。');
    }
    const { data_version, groups, entries } = data;
    if (typeof data_version !== 'string' || !data_version.trim()
        || !Array.isArray(groups) || !groups.length || !Array.isArray(entries) || !entries.length) {
      throw new Error('字典缺少版本、分类或标签。');
    }

    const counts = new Map();
    for (const group of groups) {
      if (typeof group?.id !== 'string' || !group.id.trim() || counts.has(group.id)
          || typeof group.title !== 'string' || !group.title.trim()
          || !Number.isSafeInteger(group.count) || group.count < 0) {
        throw new Error('字典包含无效或重复的分类。');
      }
      counts.set(group.id, 0);
    }

    const originals = new Map();
    const alternatives = new Map();
    const searchRows = entries.map((entry, index) => {
      if (!entry || fields.some((field) => typeof entry[field] !== 'string')
          || !entry.tag_copy.trim() || !counts.has(entry.group)) {
        throw new Error('字典第 ' + (index + 1) + ' 条标签不完整。');
      }
      const key = tagKey(entry.tag_raw);
      if (!key || originals.has(key)) throw new Error('字典第 ' + (index + 1) + ' 条标签为空或重复。');
      originals.set(key, entry);
      counts.set(entry.group, counts.get(entry.group) + 1);
      for (const name of [entry.tag_copy, ...entry.aliases.split(/[,，;；|｜、\r\n]+/)]) {
        const alias = tagKey(name);
        if (alias && !alternatives.has(alias)) alternatives.set(alias, entry);
        else if (alias && alternatives.get(alias) !== entry) alternatives.set(alias, null);
      }
      const text = tagKey([entry.tag_raw, entry.tag_copy, entry.subcategory, entry.meaning_zh,
        entry.usage_zh, entry.aliases].join('\n'));
      return { entry, text };
    });
    if (groups.some((group) => counts.get(group.id) !== group.count)) {
      throw new Error('字典分类数量与标签数量不符。');
    }

    return {
      builtIn,
      data_version,
      groups,
      entries,
      findTag(name) {
        const key = tagKey(String(name ?? ''));
        return originals.get(key) || alternatives.get(key) || null;
      },
      search(query = '', group = '') {
        const key = tagKey(query);
        return searchRows.filter(({ entry, text }) =>
          (!group || entry.group === group) && text.includes(key)).map(({ entry }) => entry);
      },
    };
  }

  function openDatabase() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open('nai-pocket-visual-tags', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('packs');
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            database = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        database = null;
        throw error;
      });
    }
    return database;
  }

  async function accessCatalog(mode, command) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('packs', mode);
      const request = command(transaction.objectStore('packs'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function serializeCatalogOperation(operation) {
    const queued = catalogQueue.then(operation);
    catalogQueue = queued.catch(() => {});
    return queued;
  }

  async function defaultCatalogData() {
    const encoded = window.PocketApp.visualTagsDefault;
    let content;
    if (encoded) {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      content = new Blob([bytes]).stream();
    } else {
      const response = await fetch('./visual-tags-default.json.gz', { cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error('内置字典文件不存在。');
      content = response.body;
    }
    return new Response(content.pipeThrough(new DecompressionStream('gzip'))).json();
  }

  function load() {
    if (cachedCatalog !== undefined) return Promise.resolve(cachedCatalog);
    if (!loading) {
      loading = serializeCatalogOperation(async () => {
        if (cachedCatalog !== undefined) return cachedCatalog;
        let data = null;
        try {
          data = await accessCatalog('readonly', (store) => store.get('catalog'));
        } catch {
          // The packaged dictionary remains available when local storage cannot be opened.
        }
        let importedCatalog = null;
        if (data) {
          try {
            importedCatalog = buildCatalog(data);
          } catch {
            // Ignore a damaged stored copy and fall back to the packaged dictionary.
          }
        }
        cachedCatalog = importedCatalog || buildCatalog(await defaultCatalogData(), { builtIn: true });
        return cachedCatalog;
      })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  function install(text) {
    return serializeCatalogOperation(async () => {
      if (typeof text !== 'string' || text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
        throw new Error('字典文件过大或无法读取，大小上限为 20 MB。');
      }
      let data;
      try {
        data = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        throw new Error('字典 JSON 格式无效。');
      }
      const catalog = buildCatalog(data);
      try {
        await accessCatalog('readwrite', (store) => store.put(data, 'catalog'));
      } catch {
        throw new Error('无法保存字典，请检查本机剩余空间。');
      }
      cachedCatalog = catalog;
      return catalog;
    });
  }

  window.PocketApp.visualTags = Object.freeze({ maxBytes, load, install });
})();
