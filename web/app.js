'use strict';

const byId = (id) => document.getElementById(id);
const desktopApp = /^http:\/\/127\.0\.0\.1:\d+$/.test(window.location?.origin || '') && !window.Pocket;
if (desktopApp) document.documentElement.classList.add('pocket-desktop');
const screen = byId('screen');
const body = byId('screen-body');
const actions = byId('screen-actions');
const main = byId('main');
const query = byId('query');
const results = byId('results');
const number = new Intl.NumberFormat('zh-CN');
const pageSize = 32;
const initialLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const initialDigits = '0123456789';
const sections = {
  character: { label: '同人角色', type: '角色标签', icon: 'character', subtitle: '按角色名查找 NovelAI 标签和效果。' },
  artist: { label: '画师', type: '画师标签', icon: 'artist', subtitle: '搜画师、看样图，收藏常用画风。' },
  knowledge: { label: '画面提示词知识', type: '提示词', icon: 'book', subtitle: '收好常用的动作、姿势和构图写法。' },
};
const galleryPacksStorageKey = 'pocket-gallery-packs-v1';
const codexAtlasUrl = 'https://novelai.quicktagcloud.com/?c=suozhang';
const galleryPacksFallback = [{
  id: 'korean-gallery',
  title: '韩国画风图库',
  section: 'artist',
  address: 'oju706/nai-pocket-library',
  defaultRating: 'unknown',
}];
const koreanPacks = [['curated', 'Curated 精选'], ['33000', '33000-Q'], ['55000', '55000-Q']];
const koreanCatalogs = new Map();
const knowledgeKinds = [['all', '全部'], ...PocketSources.knowledgeKinds];
const characterFields = [['work', '作品'], ['outfit', '服装／版本'], ['gender', '性别'], ['species', '类型']];
const genderChoices = [['', '未标注'], ['女性', '女性'], ['男性', '男性'], ['其他', '其他']];
const speciesChoices = [['', '未标注'], ['人类', '人类'], ['人外', '人外'], ['其他', '其他']];
let views = { artist: 'grid', character: 'grid', knowledge: 'list' };
let artistPageCards = [];
try {
  const saved = readJsonStorageOr('pocket-views', {});
  for (const key of Object.keys(views)) if (['grid', 'list', 'compact'].includes(saved[key])) views[key] = saved[key];
} catch { /* Default views work when preferences cannot be read. */ }

function searchText(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/\\([(),])/g, '$1').replace(/[_\s]+/g, ' ').trim();
}

function cardSearchTerms(queryValue, section) {
  const artist = section === 'artist';
  const queryText = artist ? artistTagKey(queryValue) : searchText(queryValue);
  return queryText.split(/[,，]+/).map((term) => {
    const keyword = term.trim();
    return artist ? keyword.replace(/^artist\s*:\s*/, '') : keyword;
  }).filter(Boolean);
}

function matchesCardSearch(card, terms) {
  if (!terms.length) return true;
  const words = [card.title, card.prompt, card.note, card.work, card.outfit, card.gender, card.species].join(' ');
  const searchable = card.section === 'artist' ? artistTagKey(words) : searchText(words);
  return terms.every((term) => searchable.includes(term));
}

function groupingName(title) {
  return String(title ?? '').normalize('NFKC').trim().replace(/^artist:\s*/i, '');
}

function artistGroupParts(title) {
  const name = searchText(groupingName(title));
  const [first = ''] = name;
  const [second = ''] = name.slice(first.length).trimStart();
  return { first, second, latin: foldInitial(first) };
}

function foldInitial(character) {
  return character.normalize('NFD').replace(/\p{Mark}/gu, '').toUpperCase();
}

function artistGroup(title) {
  const { first, latin } = artistGroupParts(title);
  if (/^[A-Z]$/.test(latin)) return `letter-${latin}`;
  if (/^[0-9]$/.test(first)) return `digit-${first}`;
  if (/\p{Number}/u.test(first)) return 'digit-other';
  if (/\p{Script=Han}/u.test(first)) return 'han';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return 'kana';
  if (/\p{Script=Hangul}/u.test(first)) return 'hangul';
  return /\p{Letter}/u.test(first) ? 'other-letter' : 'symbol';
}

function matchesArtistGroup(card, group) {
  if (group === 'all') return true;
  const pair = /^letter-([A-Z])([A-Z0-9])$/.exec(group);
  if (pair) {
    const { second, latin } = artistGroupParts(card.title);
    return latin === pair[1] && foldInitial(second) === pair[2];
  }
  const first = artistGroup(card.title);
  if (group === 'letters') return first.startsWith('letter-');
  if (group === 'digits') return first.startsWith('digit-');
  return first === group;
}

function postCountBand(count) {
  return Number.isSafeInteger(count) && count >= 0 ? String(Math.floor(count / 100) * 100) : 'unknown';
}

function postCountBands(cards) {
  const bands = new Set(cards.map(card => postCountBand(card.postCount)));
  const starts = [...bands].filter(band => band !== 'unknown').sort((a, b) => Number(a) - Number(b));
  if (bands.has('unknown')) starts.push('unknown');
  return starts;
}

function matchesPostCountBand(card, band) {
  return band === 'all' || postCountBand(card.postCount) === band;
}

function artistDrawTag(card) {
  return searchText(groupingName(card?.title))
    || searchText(String(card?.prompt || '').replace(/^artist:\s*/i, ''));
}

const favoriteSaves = new Map();

function favoriteIdentity(card) {
  return card.section === 'knowledge'
    ? JSON.stringify(['knowledge', String(card.id)])
    : cardIdentity(card);
}

function findSavedCard(card, cards = state.personal) {
  if (card.id?.startsWith('danbooru-tag:')) return findTagGallerySavedCard(card, cards);
  return cards.find((saved) => saved.section === card.section
    && (card.section === 'knowledge'
      ? saved.from === card.id
      : cardIdentity(saved) === cardIdentity(card)));
}

function mergeFavoritePhotos(card, current = []) {
  const photos = Array.isArray(current) ? current.map((photo) => ({ ...photo })) : [];
  for (const photo of card.photos || []) {
    if (photos.some((item) => item.url === photo.url)) continue;
    const origin = card.license ? 'Carlyone / NAX · CC BY 4.0' : card.source || '';
    photos.push({
      ...photo,
      label: [origin, photo.label || '样图'].filter(Boolean).join(' · '),
    });
  }
  return photos;
}

function savedFavoriteCard(card, existing = null) {
  if (existing) {
    return { ...existing, photos: mergeFavoritePhotos(card, existing.photos), updated: Date.now() };
  }
  const saved = {
    id: crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
    from: card.id,
    title: card.title,
    prompt: card.prompt || '',
    note: card.note || '',
    section: card.section,
    kind: card.kind,
    model: card.model || '通用',
    photos: (card.photos || []).map(({ url, label }) => ({ url, label })),
    source: card.source,
    sourceUrl: card.sourceUrl,
    license: card.license,
    local: true,
    updated: Date.now(),
    generation: card.generation,
  };
  for (const key of ['work', 'outfit', 'gender', 'species']) {
    if (card[key] !== undefined) saved[key] = card[key];
  }
  return saved;
}

function syncFavoriteControls(identity) {
  for (const control of document.querySelectorAll('[data-favorite-card]')) {
    if (control.dataset.favoriteCard !== identity) continue;
    const compact = control.classList.contains('artist-card-favorite');
    control.textContent = compact ? '♥' : '已收藏';
    control.className = compact ? 'soft compact artist-card-favorite' : 'soft compact';
    control.disabled = true;
    control.setAttribute('aria-pressed', 'true');
    control.setAttribute('aria-label', compact ? `${control.dataset.favoriteTitle} · 已收藏` : '已收藏');
    if (compact) control.title = '已收藏';
    control.removeAttribute('aria-busy');
  }
}

async function saveFavorite(card) {
  const identity = favoriteIdentity(card);
  if (favoriteSaves.has(identity)) return favoriteSaves.get(identity);
  const pending = (async () => {
    let result;
    await useCards('readwrite', (store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const existing = findSavedCard(card, request.result);
        const saved = savedFavoriteCard(card, existing);
        result = { saved, existing: Boolean(existing) };
        store.put(saved);
      };
      return request;
    });
    if (!result) throw new Error('收藏写入未完成。');
    state.personal = [result.saved, ...state.personal.filter((item) => item.id !== result.saved.id)];
    syncFavoriteControls(identity);
    return result;
  })().finally(() => {
    favoriteSaves.delete(identity);
  });
  favoriteSaves.set(identity, pending);
  return pending;
}

function favoriteControl(card, compact = false) {
  const identity = favoriteIdentity(card);
  const existing = findSavedCard(card);
  const favoriteLabel = existing ? '已收藏' : compact ? '收藏' : '♡ 收藏';
  const favorite = button(favoriteLabel, compact ? 'soft compact artist-card-favorite' : 'soft compact', async () => {
    favorite.disabled = true;
    favorite.setAttribute('aria-busy', 'true');
    favorite.textContent = compact ? '♡' : '收藏中…';
    const revision = screenRevision;
    try {
      const result = await saveFavorite(card);
      if (revision === screenRevision) {
        toast(result.existing ? '已有同一条收藏，已保留原备注和配图' : '已收藏到「我的词库」');
      }
    } catch {
      if (revision !== screenRevision) return;
      favorite.textContent = compact ? '♡' : '♡ 收藏';
      favorite.disabled = false;
      favorite.removeAttribute('aria-busy');
      toast('收藏失败，请检查手机剩余空间后重试。');
    }
  });
  favorite.dataset.favoriteCard = identity;
  favorite.dataset.favoriteTitle = card.title;
  favorite.setAttribute('aria-pressed', String(Boolean(existing)));
  if (compact) {
    favorite.textContent = existing ? '♥' : '♡';
    favorite.setAttribute('aria-label', existing ? `${card.title} · 已收藏` : `收藏 ${card.title}`);
    favorite.title = existing ? '已收藏' : '收藏';
  }
  favorite.disabled = Boolean(existing);
  return favorite;
}

function isRemote() {
  return state.mode === 'online' && (state.section === 'knowledge' ? state.knowledgeTab === 'images'
    : state.section === 'artist' ? state.artistSource === 'nax' : true);
}

function isKorean() { return state.mode === 'online' && state.section === 'artist' && state.artistSource === 'korean'; }

function galleryPackAddress(value) {
  const address = typeof value === 'string' ? value.trim() : '';
  if (!address || address.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(address)) return '';
  const segment = '[A-Za-z0-9_.-]{1,128}';
  if (new RegExp(`^[A-Za-z0-9_.-]{1,64}/${segment}$`).test(address)) return address;
  if (new RegExp(`^https://github\\.com/[A-Za-z0-9_.-]{1,64}/${segment}/?$`).test(address)) return address;
  if (new RegExp(`^https://raw\\.githubusercontent\\.com/(?:${segment}/){3,}online-pack\\.json$`).test(address)) return address;
  return '';
}

function normalizeGalleryPacks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.format !== 'nai-pocket-gallery-index' || value.version !== 1
      || !Array.isArray(value.packs) || value.packs.length < 1 || value.packs.length > 32) {
    throw new Error('图库入口清单格式不正确。');
  }
  const ids = new Set();
  const packs = value.packs.map((pack) => {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw new Error('图库入口格式不正确。');
    const id = typeof pack.id === 'string' ? pack.id.trim() : '';
    const title = typeof pack.title === 'string' ? pack.title.trim() : '';
    const section = pack.section;
    const address = galleryPackAddress(pack.address);
    const defaultRating = pack.defaultRating === undefined ? 'unknown' : pack.defaultRating;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)
        || !title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)
        || typeof section !== 'string' || !Object.prototype.hasOwnProperty.call(sections, section) || !address
        || !['sfw', 'nsfw', 'unknown'].includes(defaultRating)) {
      throw new Error('图库入口格式不正确。');
    }
    ids.add(id);
    return { id, title, section, address, defaultRating };
  });
  return { format: 'nai-pocket-gallery-index', version: 1, packs };
}

function readCachedGalleryPacks() {
  try {
    const saved = readJsonStorage(galleryPacksStorageKey);
    return normalizeGalleryPacks(saved).packs;
  } catch {
    return null;
  }
}

let galleryPacksTask = null;
function loadGalleryPacks() {
  if (galleryPacksTask) return galleryPacksTask;
  const previous = JSON.stringify(state.galleryPacks);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  galleryPacksTask = fetch('/api/gallery-packs.json', { cache: 'no-store', signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('入口清单读取失败。');
      const packs = normalizeGalleryPacks(await response.json()).packs;
      const changed = JSON.stringify(packs) !== previous;
      state.galleryPacks = packs;
      writeJsonStorage(galleryPacksStorageKey,
        { format: 'nai-pocket-gallery-index', version: 1, packs });
      if (changed && state.mode === 'online') render();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      clearTimeout(timer);
      galleryPacksTask = null;
    });
  return galleryPacksTask;
}

function appendGalleryPackEntries(target) {
  if (state.mode !== 'online' || !target) return;
  for (const pack of state.galleryPacks.filter((item) => item.section === state.section)) {
    const entry = button(pack.title, 'text-button', () => {
      if (typeof window.showPresetOnlinePack !== 'function') {
        toast('远程图库组件尚未加载，请重新打开应用。');
        return;
      }
      window.showPresetOnlinePack(pack);
    });
    entry.title = `${sections[pack.section].label} · 默认显示${pack.defaultRating === 'unknown' ? '未分级'
      : pack.defaultRating.toUpperCase()}图片`;
    target.append(entry);
  }
}

function loadKoreanCatalog(id) {
  if (!koreanCatalogs.has(id)) {
    koreanCatalogs.set(id, getJson(`/api/korean.json?pack=${id}`).then(PocketSources.koreanCards).catch((error) => {
      koreanCatalogs.delete(id);
      throw error;
    }));
  }
  return koreanCatalogs.get(id);
}

function ensureKorean() {
  if (state.korean || state.koreanTask?.pack === state.koreanPack) return;
  const task = { pack: state.koreanPack };
  const packs = task.pack === 'all' ? koreanPacks.map(([id]) => id) : [task.pack];
  state.koreanError = false;
  state.koreanTask = task;
  Promise.all(packs.map(loadKoreanCatalog)).then((catalogs) => {
    if (state.koreanTask !== task) return;
    const artists = new Map();
    for (const catalog of catalogs) for (const card of catalog) {
      if (!artists.has(card.title)) artists.set(card.title, card);
    }
    state.korean = [...artists.values()].sort((a, b) => a.title.localeCompare(b.title, 'en'));
    state.koreanPostBands = postCountBands(state.korean);
    if (state.artistPostBand !== 'all' && !state.koreanPostBands.includes(state.artistPostBand)) state.artistPostBand = 'all';
  }).catch(() => { if (state.koreanTask === task) state.koreanError = true; })
    .finally(() => {
      if (state.koreanTask !== task) return;
      state.koreanTask = null;
      if (isKorean()) renderArtistDiscovery();
      renderList();
    });
}

async function checkKorean() {
  if (state.koreanChecking) return;
  state.koreanChecking = true;
  const selection = state.koreanPack;
  renderList();
  try {
    const packs = selection === 'all' ? koreanPacks : koreanPacks.filter(([id]) => id === selection);
    const status = await Promise.all(packs.map(async ([id, label]) => {
      try { return [label, await getJson(`/api/korean-status.json?check=1&pack=${id}`)]; }
      catch { return [label, { status: 'failed' }]; }
    }));
    const message = status.every(([, item]) => item.status === 'current') ? '所选韩国图包与目录一致。'
      : status.filter(([, item]) => item.status !== 'current').map(([label, item]) =>
        `${label}：${item.message || '暂时无法检查'}`).join('；');
    if (state.koreanPack === selection) state.koreanStatus = message;
    toast(message);
  } catch { toast('检查原库失败，请稍后重试。'); }
  finally { state.koreanChecking = false; renderList(); }
}

function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function button(label, className, click, glyph) {
  const el = node('button', className, glyph ? undefined : label);
  el.type = 'button';
  if (glyph) {
    el.setAttribute('aria-label', label);
    el.append(icon(glyph));
  }
  el.addEventListener('click', click);
  return el;
}

let pageJumpSequence = 0;
function pageJump(current, pages, move) {
  const form = node('form', 'page-jump');
  const input = node('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.enterKeyHint = 'go';
  input.maxLength = 12;
  input.value = String(current + 1);
  input.setAttribute('aria-label', `跳转页码，1 到 ${pages}`);
  const jump = node('button', 'soft compact', '跳转');
  jump.type = 'submit';
  const error = node('p', 'page-error');
  error.id = `page-error-${++pageJumpSequence}`;
  error.setAttribute('role', 'status');
  error.hidden = true;
  input.setAttribute('aria-describedby', error.id);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.normalize('NFKC').trim();
    const target = Number(value);
    if (!/^\d+$/.test(value) || target < 1 || target > pages) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = `请输入 1–${pages} 的页码。`;
      error.hidden = false;
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    input.value = String(target);
    move(target - 1);
  });
  form.append(node('span', '', `${current + 1} / ${pages} 页`), input, jump, error);
  return form;
}

function pageSteps(current, pages, move) {
  const nav = node('nav', 'page-steps');
  nav.setAttribute('aria-label', '分页');
  const previous = button('上一页', 'soft', () => move(current - 1));
  const next = button('下一页', 'soft', () => move(current + 1));
  previous.disabled = current === 0;
  next.disabled = current === pages - 1;
  nav.append(previous, node('span', '', `${current + 1} / ${pages} 页`), next);
  return nav;
}

let toastTimer;
function toast(message) {
  const el = byId('toast');
  (screen.open ? screen : document.body).append(el);
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

const pending = new Map();
let requestId = 0;
function native(action, value = null, timeout = 0) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    if (!window.Pocket) {
      reject(new Error('请在安卓 App 中使用此功能。'));
      return;
    }
    const timer = timeout ? setTimeout(() => {
      pending.delete(id);
      reject(new Error('系统未回应复制请求。'));
    }, timeout) : null;
    pending.set(id, { resolve, reject, timer });
    try {
      window.Pocket.request(JSON.stringify({ id, action, value }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

window.PocketResult = (id, value, error) => {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  if (error) request.reject(new Error(error));
  else request.resolve(value);
};

window.PocketProgress = (percentage) => {
  const phase = state.importingRemote ? (percentage >= 90 ? '正在建立画师目录' : '正在下载并导入 ZIP') : '正在建立索引';
  state.packMessage = percentage < 0 ? phase + '…' : `${phase} · ${percentage}%`;
  if (state.importing && state.section === 'artist' && state.mode === 'online') renderList();
};

const tagDictionaryTranslations = new Map();
const tagDictionaryQueue = new Set();
const tagDictionaryWaiters = new Set();
let tagDictionaryFlushTimer = 0;
let tagDictionaryFlushRunning = false;
let tagDictionaryGeneration = 0;
const tagDictionaryBatchSize = 200;

async function tagDictionaryRequest(action, keys = []) {
  if (!desktopApp) return native(action, action === 'tagDictionaryLookup' ? JSON.stringify(keys) : null);
  const path = {
    tagDictionaryStatus: 'status', tagDictionaryInstall: 'install',
    tagDictionaryRemove: 'remove', tagDictionaryLookup: 'lookup',
  }[action];
  const method = path === 'status' ? 'GET' : 'POST';
  const options = { method, mode: 'same-origin', redirect: 'error', cache: 'no-store' };
  if (method === 'POST') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(path === 'lookup' ? keys : {});
  }
  const response = await fetch('/api/tag-dictionary/' + path, options);
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || '暂时无法读取本机词典。');
  return result;
}

function tagDictionaryKey(value) {
  return PocketSources.tagGalleryTag(value);
}

function tagDictionaryUniqueKeys(values) {
  const keys = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const key = tagDictionaryKey(value);
    if (key && key.length <= 512) keys.add(key);
  }
  return [...keys];
}

function tagDictionarySnapshot(keys) {
  return Object.fromEntries(keys
    .filter((key) => tagDictionaryTranslations.get(key))
    .map((key) => [key, tagDictionaryTranslations.get(key)]));
}

function tagDictionarySettleWaiters() {
  for (const waiter of [...tagDictionaryWaiters]) {
    if (!waiter.keys.every((key) => tagDictionaryTranslations.has(key))) continue;
    tagDictionaryWaiters.delete(waiter);
    waiter.resolve(tagDictionarySnapshot(waiter.keys));
  }
}

function tagDictionaryScheduleFlush() {
  if (tagDictionaryFlushRunning || tagDictionaryFlushTimer || !tagDictionaryQueue.size
    || (!window.Pocket && !desktopApp)) return;
  tagDictionaryFlushTimer = setTimeout(tagDictionaryFlush, 16);
}

async function tagDictionaryFlush() {
  tagDictionaryFlushTimer = 0;
  if (tagDictionaryFlushRunning) return;
  tagDictionaryFlushRunning = true;
  try {
    while (tagDictionaryQueue.size) {
      const generation = tagDictionaryGeneration;
      const keys = [...tagDictionaryQueue].slice(0, tagDictionaryBatchSize);
      for (const key of keys) tagDictionaryQueue.delete(key);
      let payload = {};
      try {
        const returned = await tagDictionaryRequest('tagDictionaryLookup', keys);
        if (returned && typeof returned === 'object' && !Array.isArray(returned)) payload = returned;
      } catch {
        // A missing or damaged dictionary quietly leaves every original tag untouched.
      }
      if (generation === tagDictionaryGeneration) {
        for (const key of keys) {
          const value = Object.hasOwn(payload, key) && typeof payload[key] === 'string'
            ? payload[key].trim() : '';
          tagDictionaryTranslations.set(key, value);
        }
        tagDictionarySettleWaiters();
      }
    }
  } finally {
    tagDictionaryFlushRunning = false;
    tagDictionarySettleWaiters();
    tagDictionaryScheduleFlush();
  }
}

function tagDictionaryLookup(values) {
  const keys = tagDictionaryUniqueKeys(values);
  if (!keys.length || (!window.Pocket && !desktopApp)) return Promise.resolve(tagDictionarySnapshot(keys));
  const missing = keys.filter((key) => !tagDictionaryTranslations.has(key));
  if (!missing.length) return Promise.resolve(tagDictionarySnapshot(keys));
  return new Promise((resolve) => {
    const waiter = { keys, resolve };
    tagDictionaryWaiters.add(waiter);
    for (const key of missing) tagDictionaryQueue.add(key);
    tagDictionaryScheduleFlush();
  });
}

function tagDictionaryClearCache() {
  tagDictionaryGeneration++;
  tagDictionaryTranslations.clear();
  tagDictionaryQueue.clear();
  clearTimeout(tagDictionaryFlushTimer);
  tagDictionaryFlushTimer = 0;
  for (const waiter of tagDictionaryWaiters) waiter.resolve({});
  tagDictionaryWaiters.clear();
}

function tagDictionaryAppend(target, name, guard = null) {
  const key = tagDictionaryKey(name);
  if (!target || !key) return null;
  const label = node('span', 'tag-dictionary-translation');
  label.hidden = true;
  target.append(label);
  const current = () => {
    try { return label.isConnected && (!guard || guard()); } catch { return false; }
  };
  if (tagDictionaryTranslations.has(key)) {
    const value = tagDictionaryTranslations.get(key);
    if (!value) {
      label.remove();
      return null;
    }
    label.textContent = value;
    label.hidden = false;
    return label;
  }
  tagDictionaryLookup([key]).then((translations) => {
    if (!current()) return;
    const value = translations[key] || tagDictionaryTranslations.get(key) || '';
    if (!value || !current()) {
      label.remove();
      return;
    }
    label.textContent = value;
    label.hidden = false;
  }).catch(() => label.remove());
  return label;
}

function showTagDictionarySettings(back = null) {
  openScreen('中文标签词典', back);
  const revision = screenRevision;
  const section = toolSection('ffdkj 丹波鲁中英词典',
    '可选下载约 25 MB 的本地词典，用于在原始标签旁显示中文。词典不会打包进 App；点击下载后从 GitHub 获取并校验，安装后即可离线使用。');
  const status = node('p', 'detail-note tag-dictionary-status', '正在读取安装状态…');
  status.setAttribute('aria-live', 'polite');
  const controls = node('div', 'tool-actions');
  section.append(status, controls);
  const source = node('p', 'detail-note',
    '数据来源：ffdkj-Danbooru_Tag-Chinese-English-Translation-Table，按 MIT 许可使用。译文只作辅助显示；复制、搜索、图站请求、Wiki 地址与画风串仍使用原词。');
  const sourceActions = node('div', 'tool-actions');
  sourceActions.append(button('打开原始仓库', 'text-button', () => openLink(
    'https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table')));
  section.append(source, sourceActions);
  let info = null;
  let busy = false;
  let busyLabel = '';
  let failure = '';
  let readingStatus = Boolean(window.Pocket || desktopApp);

  function renderStatus() {
    const installedBytes = Number(info?.bytes) || 0;
    if (busy) {
      status.textContent = busyLabel;
    } else if (failure) {
      status.textContent = failure;
    } else if (info?.installed) {
      status.textContent = `已安装 ${info.version || 'v2026-11-01'} · ${(installedBytes / (1024 * 1024)).toFixed(1)} MB · 安装态已校验，可离线使用。`;
    } else if (info) {
      status.textContent = '未安装。词典缺失时所有原词照常显示、搜索和复制；安装失败不会影响搜图。';
    } else if (readingStatus) {
      status.textContent = '正在读取安装状态…';
    } else {
      status.textContent = '暂时无法读取安装状态，可以直接重试安装。';
    }
    status.classList.toggle('danger', Boolean(failure));
    controls.replaceChildren();
    if (!window.Pocket && !desktopApp) {
      controls.append(node('span', 'muted', '浏览器预览不安装本地词典，请在 Android App 中使用。'));
      return;
    }
    const installLabel = info?.installed ? '校验安装' : failure ? '重试下载并安装（约 25 MB）' : '下载并安装（约 25 MB）';
    const install = button(busy ? busyLabel : installLabel, 'primary', async () => {
      if (info?.installed) {
        await runDictionaryAction('tagDictionaryStatus', '正在校验本机词典…', '中文标签词典状态正常');
        return;
      }
      await runDictionaryAction('tagDictionaryInstall', '正在下载并校验词典…', '中文标签词典已安装');
    });
    install.disabled = busy || readingStatus;
    controls.append(install);
    if (info?.installed && !busy) {
      controls.append(button('卸载词典', 'soft', async () => {
        if (!confirm('卸载中文标签词典？原词、收藏和图站功能都不会删除。')) return;
        await runDictionaryAction('tagDictionaryRemove', '正在卸载词典…', '中文标签词典已卸载');
      }));
    }
  }

  async function runDictionaryAction(action, label, successMessage) {
    if (busy) return;
    busy = true;
    busyLabel = label;
    failure = '';
    renderStatus();
    try {
      const result = await tagDictionaryRequest(action);
      if (action === 'tagDictionaryInstall' || action === 'tagDictionaryRemove') {
        tagDictionaryClearCache();
        if (desktopApp) renderList();
      }
      if (revision !== screenRevision) return;
      info = result;
      toast(successMessage);
    } catch (error) {
      if (revision !== screenRevision) return;
      failure = error?.message || '词典操作失败，请重试。';
    } finally {
      if (revision === screenRevision) {
        busy = false;
        renderStatus();
      }
    }
  }

  renderStatus();
  if (window.Pocket || desktopApp) {
    tagDictionaryRequest('tagDictionaryStatus').then((result) => {
      if (revision !== screenRevision) return;
      readingStatus = false;
      info = result;
      failure = '';
      renderStatus();
    }).catch((error) => {
      if (revision !== screenRevision) return;
      readingStatus = false;
      failure = error?.message || '暂时无法读取词典安装状态。';
      renderStatus();
    });
  }
}

window.tagDictionaryKey = tagDictionaryKey;
window.tagDictionaryLookup = tagDictionaryLookup;
window.tagDictionaryAppend = tagDictionaryAppend;
window.tagDictionaryClearCache = tagDictionaryClearCache;
window.showTagDictionarySettings = showTagDictionarySettings;

let database;
function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const open = indexedDB.open('nai-pocket-library', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('cards', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }).catch((error) => {
      database = null;
      throw error;
    });
  }
  return database;
}

async function useCards(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cards', mode);
    const request = operation(tx.objectStore('cards'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || request.error);
  });
}

async function loadPersonal() {
  try {
    state.personal = (await useCards('readonly', (store) => store.getAll())).sort((a, b) => b.updated - a.updated);
    state.personalError = false;
  } catch {
    state.personalError = true;
  }
  renderList();
}


function openLink(url) {
  if (window.Pocket) native('openLink', url).catch((error) => toast(error.message));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function addArtistCardsToMixer(cards) {
  const chain = window.PocketApp.chain;
  const model = chain.mixerModel();
  const groups = new Map();
  let skipped = 0;
  for (const card of cards) {
    const tag = artistChainCardTag(card);
    const entry = normalizeArtistChainTag(tag);
    if (entry.error) { skipped++; continue; }
    const target = artistModelSeries(card.model) || model;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(entry.tag);
  }
  const message = [];
  for (const [target, tags] of groups) {
    const result = chain.addToMixerPool(tags, { model: target });
    message.push(`${target}「${result.pool}」加入 ${result.added} 位${result.duplicates ? `，重复 ${result.duplicates} 位` : ''}`);
    if (result.storageError || result.error) message.push(result.storageError || result.error);
  }
  if (skipped) message.push(`跳过 ${skipped} 个无法识别的标签`);
  toast(message.join(' · ') || '本页没有可加入的画师。');
}

function openTagGalleryWebsite(url) {
  if (window.Pocket) return native('openTagGalleryWebsite', url).catch((error) => toast(error.message));
  openLink(url);
}

function tagGalleryButtons(getTag, back = null) {
  const links = node('div', 'tag-gallery-actions');
  for (const gallery of PocketSources.tagGalleries) {
    links.append(button(`${gallery.label} 图库`, 'soft compact', () => {
      showTagGalleries(getTag(), back, gallery.id);
    }));
  }
  return links;
}

function showTagGalleries(initialTag = '', back = null, initialSite = 'danbooru') {
  if (typeof window.showInAppTagGallery === 'function') {
    window.showInAppTagGallery(initialTag, back, initialSite);
    return;
  }
  if (!window.Pocket) {
    openLink(PocketSources.tagGallerySearchUrl(initialSite, initialTag));
    return;
  }
  openScreen('外站找图', back);
  body.append(toolSection('图库模块未载入', '请重新打开 App 后再试。'));
}

const tagGalleryKindMap = Object.freeze({
  artist: { key: 'artist', label: '画师', section: 'artist' },
  character: { key: 'character', label: '角色', section: 'character' },
  copyright: { key: 'copyright', label: '作品', section: 'character' },
  series: { key: 'copyright', label: '作品', section: 'character' },
  general: { key: 'general', label: '通用', section: 'knowledge' },
  meta: { key: 'meta', label: '元数据', section: 'knowledge' },
  metadata: { key: 'meta', label: '元数据', section: 'knowledge' },
  '0': { key: 'general', label: '通用', section: 'knowledge' },
  '1': { key: 'artist', label: '画师', section: 'artist' },
  '3': { key: 'copyright', label: '作品', section: 'character' },
  '4': { key: 'character', label: '角色', section: 'character' },
  '5': { key: 'meta', label: '元数据', section: 'knowledge' },
  画师: { key: 'artist', label: '画师', section: 'artist' },
  作品: { key: 'copyright', label: '作品', section: 'character' },
  角色: { key: 'character', label: '角色', section: 'character' },
  通用: { key: 'general', label: '通用', section: 'knowledge' },
  元数据: { key: 'meta', label: '元数据', section: 'knowledge' },
});

function tagGalleryKindInfo(value) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  const key = raw.toLocaleLowerCase();
  return Object.hasOwn(tagGalleryKindMap, key) ? tagGalleryKindMap[key] : {
    key: `unknown:${key || 'blank'}`,
    label: raw || '未分类',
    raw,
    section: '',
  };
}

function isDanbooruTagFavorite(card) {
  return Boolean(card?.from?.startsWith('danbooru-tag:'));
}

function tagGalleryFavoriteCard(tag) {
  const original = String(tag?.name ?? '').trim();
  const kind = tagGalleryKindInfo(tag?.kind);
  if (!original || !kind.section) return null;
  const card = {
    id: `danbooru-tag:${kind.key}:${original}`,
    title: original,
    prompt: original,
    section: kind.section,
    kind: kind.section === 'knowledge' ? 'general' : undefined,
    model: '通用',
    source: 'Danbooru',
    sourceUrl: 'https://danbooru.donmai.us/wiki_pages/' + encodeURIComponent(PocketSources.tagGalleryTag(original)),
    photos: [],
  };
  if (kind.key === 'copyright') card.work = original;
  return card;
}

function findTagGallerySavedCard(card, cards = state.personal) {
  const key = artistTagKey(card.prompt);
  return cards.find((saved) => saved.section === card.section
    && (saved.from === card.id
      || ((saved.model || '通用') === '通用' && !saved.outfit
        && artistTagKey(String(saved.prompt || '').replace(/^artist\s*:\s*/i, '')) === key)));
}

function tagGalleryFavoriteSaved(tag) {
  const card = tagGalleryFavoriteCard(tag);
  return Boolean(card && findTagGallerySavedCard(card));
}

async function favoriteTagGalleryTag(tag, back = null) {
  const card = tagGalleryFavoriteCard(tag);
  if (!card) return;
  const revision = screenRevision;
  const stored = await useCards('readonly', (store) => store.getAll());
  const existing = findTagGallerySavedCard(card, stored);
  if (existing) {
    if (revision === screenRevision) showEditor(existing, back, card.prompt);
    return;
  }
  const result = await saveFavorite(card);
  if (revision === screenRevision) {
    toast(result.existing ? '此标签已在「我的词库」' : `已收藏到「${sections[card.section].label}」`);
  }
}

function tagGalleryFavoriteButton(tag, back) {
  const control = button('', 'soft compact', async () => {
    const scroll = body.scrollTop;
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    try {
      await favoriteTagGalleryTag(tag, () => back(scroll));
    } catch {
      if (control.isConnected) toast('收藏失败，请稍后重试。');
    } finally {
      if (control.isConnected) refresh();
    }
  });
  function refresh() {
    const label = tagGalleryFavoriteSaved(tag) ? '编辑收藏' : '收藏';
    control.textContent = label;
    control.setAttribute('aria-label', `${label} ${tag.name}`);
    control.disabled = false;
    control.removeAttribute('aria-busy');
  }
  refresh();
  return control;
}

function tagGalleryReferenceTags(value, kind = 'general') {
  const source = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  const parsed = extractPromptTags(source)
    .map((tag) => tag.name.trim())
    .filter(Boolean);
  const names = parsed.length ? parsed : [PocketSources.tagGalleryTag(source)].filter(Boolean);
  return [...new Set(names)].map((name) => ({ name, kind }));
}

function parsedPromptReferenceTags(value) {
  const names = extractPromptTags(String(value ?? ''))
    .map((tag) => tag.name.trim())
    .filter(Boolean);
  return [...new Set(names)].map((name) => ({ name, kind: '' }));
}

function tagGalleryReferenceData(tags, source = '') {
  return {
    found: false,
    metadataType: '图站参考标签',
    message: '这些是图站的关联标签，不是原图的生成提示词。',
    referenceTags: tags,
    referenceSource: source,
    metadata: {},
  };
}

function openTagGalleryReferenceTool(tags, source = '', back = null, initialSite = 'danbooru') {
  const normalized = (Array.isArray(tags) ? tags : [tags])
    .map((tag) => typeof tag === 'string' ? { name: tag, kind: '' } : tag)
    .filter((tag) => tag && String(tag.name || '').trim())
    .map((tag) => ({ name: String(tag.name).trim(), kind: String(tag.kind || '').trim() }));
  if (!normalized.length) return;
  showPromptImport(tagGalleryReferenceData(normalized, source), {
    back,
    referenceTags: normalized,
    referenceSource: source,
    referenceSite: initialSite,
    referenceSelected: normalized.slice(0, 1).map((tag) => tag.name),
  });
}

function showManualTagEditor(name, section = 'knowledge') {
  const value = String(name ?? '').normalize('NFKC').trim();
  if (!value) return;
  const target = ['artist', 'character', 'knowledge'].includes(section) ? section : 'knowledge';
  const tag = PocketSources.tagGalleryTag(value);
  showEditor({
    section: target,
    kind: target === 'knowledge' ? 'general' : undefined,
    title: tag || value,
    prompt: target === 'artist' ? `artist:${tag || value}` : (tag || value),
    note: '来自图站，尚未在现有资源库中自动匹配；请核实后再保存。',
    model: '通用',
  });
}

function searchTagGalleryInLibrary(tagValue, back = null, returnLabel = '返回图站/来源') {
  const tag = typeof tagValue === 'string'
    ? { name: tagValue, kind: '' } : (tagValue || {});
  const name = String(tag.name ?? '').normalize('NFKC').trim();
  if (!name) return;
  const kind = tagGalleryKindInfo(tag.kind);
  if (!kind.section) {
    toast(`「${kind.label}」类别未映射，请手动选择词库分类。`);
    showManualTagEditor(name);
    return;
  }
  if (screen.open) closeScreen();
  state.section = kind.section;
  state.mode = 'online';
  state.page = 0;
  state.galleryFocus = false;
  state.kind = 'all';
  state.artistGroup = 'all';
  state.artistPostBand = 'all';
  state.artistShuffle = 0;
  state.characterFilters = {};
  if (kind.section === 'knowledge') state.knowledgeTab = 'basic';
  if (kind.section === 'character' && !['V5', 'V4.5'].includes(state.model)) state.model = 'V5';
  if (kind.section === 'artist' && state.artistSource === 'imported' && !state.packRows.length) {
    state.artistSource = 'korean';
  }
  state.tagGalleryReturn = typeof back === 'function'
    ? { back, label: returnLabel, section: kind.section, mode: 'online' }
    : null;
  query.value = name;
  render();
  main.scrollTop = 0;
  toast(`已在${sections[kind.section].label}搜索「${name}」`);
}

window.searchTagGalleryInLibrary = searchTagGalleryInLibrary;
window.openTagGalleryReferenceTool = openTagGalleryReferenceTool;
window.showManualTagEditor = showManualTagEditor;

function appendTagGalleryActions(target, card, back = null, photoIndex = 0) {
  if (!['artist', 'character', 'knowledge'].includes(card.section)) return;
  const value = card.section === 'artist' ? artistChainCardTag(card) || artistCardTag(card)
    : card.section === 'knowledge' ? card.prompt || card.title
      : card.local && !isDanbooruTagFavorite(card) ? card.title : card.prompt || card.title;
  const references = card.section === 'knowledge' ? tagGalleryReferenceTags(value) : [];
  const tag = card.section === 'knowledge'
    ? references.map((item) => PocketSources.tagGalleryTag(item.name)).filter(Boolean).join(' ')
    : PocketSources.tagGalleryTag(value);
  if (!tag) return;
  const section = node('section', 'tag-gallery-search');
  const backToCard = () => showCard(card, photoIndex, back);
  if (card.section === 'knowledge') {
    if (references.length === 1) {
      section.append(node('h3', '', '在 App 内找图'), tagGalleryButtons(() => tag, backToCard));
    } else {
      section.append(
        node('h3', '', '逐词选择后找图'),
        button('选择参考标签并找图', 'soft compact', () =>
          openTagGalleryReferenceTool(references, '画面提示词知识', backToCard)),
      );
    }
  } else {
    section.append(node('h3', '', '在 App 内找图'), tagGalleryButtons(() => tag, backToCard));
  }
  target.append(section);
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('读取失败');
  return response.json();
}

function ensureOnline(check = false) {
  if (state.onlineTask) return state.onlineTask;
  if (state.online && !check) return;
  state.onlineError = false;
  state.onlineTask = fetch('/api/nax.json' + (check ? '?check=1' : ''))
    .then(async (response) => {
      if (!response.ok) throw new Error('读取失败');
      const status = response.headers.get('X-Pocket-Update');
      if (!state.online || status !== 'current') {
        state.online = PocketSources.onlineCards(await response.json(), response.headers.get('X-Pocket-Revision') || '');
      } else {
        await response.body?.cancel();
      }
      state.hasOnline = true;
      if (check) toast(status === 'current' ? '资源目录已是最新' : '已用新目录覆盖旧目录');
    })
    .catch(() => {
      if (check) toast('检查更新失败，当前目录仍可使用。');
      else state.onlineError = true;
    })
    .finally(() => {
      state.onlineTask = null;
      render();
    });
  renderList();
  return state.onlineTask;
}

async function checkForSavedDirectory() {
  if (!window.Pocket) return;
  try {
    state.hasOnline = await native('hasOnline');
    if (state.hasOnline && isRemote()) ensureOnline();
  } catch {
    // The download button can still load a directory.
  }
}

function loadSavedNaxDirectory(revision) {
  if (!window.Pocket || state.online) return null;
  return state.onlineTask || (async () => {
    const cached = state.hasOnline || await native('hasOnline');
    if (cached && revision === screenRevision) await ensureOnline();
  })();
}

let packListTask;
function loadPacks() {
  if (!window.Pocket) return Promise.resolve(state.packs);
  if (packListTask) return packListTask;
  packListTask = native('listPacks').then((packs) => {
    state.packs = packs;
    render();
    return packs;
  }).catch(() => {
    toast('读取已有数据包失败。');
    return state.packs;
  }).finally(() => { packListTask = null; });
  return packListTask;
}

async function loadImportedArtistCatalogs() {
  const packs = packListTask ? await packListTask : state.packs;
  const selectedPack = state.pack;
  const selectedRows = state.packRows;
  return Promise.allSettled(packs.map(async (pack) => {
    if (pack.id === selectedPack?.id && selectedRows.length) return selectedRows;
    return PocketSources.packCards(pack, await getJson(`/api/pack/${encodeURIComponent(pack.id)}.json`));
  }));
}

async function selectPack(id) {
  const pack = state.packs.find((item) => item.id === id);
  state.model = 'pack';
  state.artistSource = 'imported';
  state.pack = pack || null;
  state.packRows = [];
  state.packMessage = pack ? '正在读取目录…' : '';
  resetPage();
  render();
  if (!pack) return;
  try {
    const index = await getJson(`/api/pack/${pack.id}.json`);
    if (state.pack !== pack) return;
    state.packRows = PocketSources.packCards(pack, index);
    state.packMessage = '';
  } catch {
    if (state.pack !== pack) return;
    state.packMessage = '读取失败。可以重新选择原文件。';
  }
  renderArtistDiscovery();
  renderList();
}

async function importPack(address = '') {
  if (state.importing) return;
  const remote = typeof address === 'string' && address.trim();
  if (state.section !== 'artist' || state.mode !== 'online') resetPage();
  state.section = 'artist';
  state.mode = 'online';
  if (state.galleryFocus) setGalleryLayout(false);
  state.importing = true;
  state.importingRemote = Boolean(remote);
  state.packMessage = remote ? '正在准备下载图包…' : '请选择原版画师数据包或自制 ZIP…';
  render();
  try {
    const pack = await native(remote ? 'importRemotePack' : 'importPack', remote || null);
    state.packMessage = '';
    if (pack) {
      await loadPacks();
      if (state.mode === 'online' && state.section === 'artist') await selectPack(pack.id);
      toast('已有数据包导入完成');
    }
  } catch (error) {
    state.packMessage = '';
    toast(error.message);
  } finally {
    state.importing = false;
    state.importingRemote = false;
    render();
  }
}

function showPackSources(back = null) {
  openScreen('其他图包', back);
  if (desktopApp) {
    const list = toolSection('在线图包', '点开目录即可浏览，缩略图和原图按需加载。');
    const restore = () => showPackSources(back);
    for (const pack of state.galleryPacks) {
      const row = node('div', 'pack-source pack-source-row');
      const label = node('div');
      label.append(node('strong', '', pack.title), node('small', '', sections[pack.section].label));
      row.append(label, button(`打开${pack.title}`, 'soft compact', () => window.showPresetOnlinePack(pack, restore)));
      list.append(row);
    }
    const controls = node('div', 'tool-actions');
    controls.append(button('在线社区画风', 'soft', () => showRemoteSharedStylePack(restore)),
      button('导入本地 ZIP', 'soft', () => showSharedStylePack(restore)),
      button('自定义 GitHub 图包', 'soft', () => showOnlinePack(restore)),
      button('刷新入口', 'text-button', async () => {
        const current = screenRevision;
        const refreshed = await loadGalleryPacks();
        if (current !== screenRevision) return;
        if (refreshed) restore();
        else toast('暂时无法刷新，仍可打开已有图包。');
      }));
    list.append(controls);
    return;
  }

  const start = toolSection('打开图包', '先选择图包入口。自定义 GitHub 可直接浏览；本地 ZIP 会在 App 中导入并建立画师目录。');
  start.classList.add('pack-source-start');
  const shortcuts = node('div', 'pack-start-actions');
  shortcuts.append(
    button('自定义 GitHub', 'primary', () => showOnlinePack(showPackSources)),
    button(window.Pocket ? '导入本地 ZIP' : '打开本地 ZIP', 'soft', () => {
      closeScreen();
      importPack();
    }),
  );
  if (window.Pocket) {
    shortcuts.append(button('在线社区画风', 'soft', () => showRemoteSharedStylePack(showPackSources)));
  }
  start.append(shortcuts);

  const imported = node('div', 'pack-start-existing');
  imported.append(node('h3', '', '已导入的图包'));
  if (state.packs.length) {
    const list = node('div', 'pack-source-list');
    for (const pack of state.packs) {
      const row = node('div', 'pack-source pack-source-row');
      const label = node('div');
      label.append(node('strong', '', pack.name), node('small', '', '本机导入 · 画师图包'));
      row.append(label, button('打开', 'soft compact', () => {
        closeScreen();
        selectPack(pack.id);
      }));
      list.append(row);
    }
    imported.append(list);
  } else {
    imported.append(node('p', 'pack-source-empty muted', '还没有导入本地图包；可从上方 ZIP 或 GitHub 下载入口开始。'));
  }
  start.append(imported);

  if (window.Pocket) {
    const remote = toolSection('已有图库入口', '远程清单里的图库直接打开；刷新只更新入口，不会改动已导入的图包。');
    for (const pack of state.galleryPacks) {
      const row = node('div', 'pack-source pack-source-row');
      const label = node('div');
      label.append(node('strong', '', pack.title), node('small', '', `${sections[pack.section].label} · ${pack.address}`));
      row.append(label, button('打开', 'soft compact', () => window.showPresetOnlinePack(pack, showPackSources)));
      remote.append(row);
    }
    const refresh = button('刷新入口清单', 'text-button', async () => {
      const revision = screenRevision;
      refresh.disabled = true;
      refresh.textContent = '正在刷新…';
      const updated = await loadGalleryPacks();
      if (revision !== screenRevision) return;
      if (updated) {
        showPackSources();
        toast('远程图库入口已刷新');
      } else {
        refresh.disabled = false;
        refresh.textContent = '刷新入口清单';
        toast('远程入口读取失败，继续使用本机入口');
      }
    });
    remote.append(refresh);
    const shared = toolSection('韩国社区画风 ZIP', '直接读取手机里 NAImakeArtistGroup 的社区画风合集或画风测试包。');
    shared.append(button('打开社区画风图包', 'soft', () => showSharedStylePack(showPackSources)));
  } else {
    const remote = toolSection('已有图库入口', '远程清单里的图库可直接浏览；入口由应用自动更新。');
    for (const pack of state.galleryPacks) {
      const row = node('div', 'pack-source pack-source-row');
      const label = node('div');
      label.append(node('strong', '', pack.title), node('small', '', `${sections[pack.section].label} · ${pack.address}`));
      row.append(label, button('打开', 'soft compact', () => window.showPresetOnlinePack(pack, showPackSources)));
      remote.append(row);
    }
  }
  const sources = toolSection('从原作者下载', '在浏览器保存所选图包，再回到这里导入。作者的全量包较大，请按需要选择。');
  const originalRoot = 'https://huggingface.co/baqu2213/PoemForSmallFThings/blob/main/NAIA/';
  for (const [title, info, path] of [
    ['V5 Curated 精选', '约 1.03 GB · 已有在线目录', 'NAID5_artist_thumbnail/NAID5-33000-55000-Curated'],
    ['V5 33000-Q', '约 4.62 GB', 'NAID5_artist_thumbnail/NAID5F-33000-Q'],
    ['V5 55000-Q', '约 3.19 GB', 'NAID5_artist_thumbnail/NAID5F-55000-Q'],
    ['V4.5 31000 版', '约 2.73 GB', 'NAID4.5_artist_thumbnail_31000/artist_thumbnail_nai'],
  ]) {
    const row = node('div', 'pack-source pack-source-row');
    const label = node('div');
    label.append(node('strong', '', title), node('small', '', info));
    row.append(label, button('下载页', 'soft compact', () => openLink(originalRoot + path)));
    sources.append(row);
  }
  const zip = toolSection('导入自制 ZIP', '把 JPG、PNG 或 WebP 压缩成 ZIP。单张图片可用画师名作文件名，多张图片可放进以画师名命名的文件夹。');
  zip.append(button('选择手机上的图包', 'primary', () => { closeScreen(); importPack(); }));
  const cloud = toolSection('从 GitHub 下载并解压', '填写公开 Release 附件或 raw.githubusercontent.com 的 ZIP 直链。App 下载完成后在本机建立画师目录。');
  const address = textInput('input', '', 'https://…/我的画师图包.zip', 2048);
  address.type = 'url';
  address.autocapitalize = 'off';
  const download = button('下载并导入 ZIP', 'primary', () => {
    const value = address.value.trim();
    if (!value) { toast('请先填写 ZIP 下载地址。'); address.focus(); return; }
    closeScreen();
    importPack(value);
  });
  cloud.append(field('公开 ZIP 下载地址', address), download);
}

function chooseSection(section) {
  if (section === state.section) return;
  state.section = section;
  state.mode = 'online';
  state.kind = 'all';
  state.model = 'V5';
  state.galleryFocus = false;
  state.artistGroup = 'all';
  state.artistShuffle = 0;
  state.characterFilters = {};
  if (section === 'artist') state.artistSource = 'korean';
  if (state.hasOnline && isRemote()) ensureOnline();
  resetResults();
}

function chooseMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.kind = 'all';
  state.artistGroup = 'all';
  state.artistShuffle = 0;
  state.characterFilters = {};
  if (isRemote() && state.hasOnline) ensureOnline();
  resetResults();
}

function resetPage() {
  state.page = 0;
  main.scrollTop = 0;
}

function resultPageSize() {
  return state.galleryFocus ? state.galleryColumns * 12 : pageSize;
}

function setGalleryLayout(focus, columns = state.galleryColumns) {
  const anchor = state.page * resultPageSize();
  state.galleryFocus = focus;
  state.galleryColumns = columns;
  state.page = Math.floor(anchor / resultPageSize());
  main.scrollTop = 0;
}

function resetResults() {
  query.value = '';
  resetPage();
  render();
}

function chip(label, selected, click) {
  const el = button(label, 'chip', click);
  el.setAttribute('aria-pressed', String(selected));
  return el;
}

function renderArtistDiscovery() {
  const tools = byId('artist-discovery');
  if (state.section !== 'artist') {
    tools.hidden = true;
    tools.replaceChildren();
    return;
  }
  const korean = isKorean();
  const previousPanel = tools.querySelector('.artist-filter-panel');
  const wasOpen = previousPanel?.open;
  const panelSections = [byId('filters'), byId('resource-tabs'), byId('view-options')];
  tools.hidden = false;
  tools.setAttribute('aria-label', korean ? '名称与作品数筛选' : '按名称开头分类');
  document.querySelector('.shell').classList.toggle('gallery-focus', state.galleryFocus);
  tools.replaceChildren();

  const pair = /^letter-([A-Z])([A-Z0-9])$/.exec(state.artistGroup);
  const groupLabels = {
    letters: '全部字母',
    digits: '全部数字',
    han: '汉字',
    kana: '假名',
    hangul: '韩文',
    'other-letter': '其他文字',
    symbol: '符号',
    'digit-other': '其他数字',
  };
  let nameFilter = '';
  if (pair) nameFilter = `名称 ${pair[1]}${pair[2]}`;
  else if (/^letter-([A-Z])$/.test(state.artistGroup)) nameFilter = `名称 ${state.artistGroup.slice(-1)}`;
  else if (/^digit-[0-9]$/.test(state.artistGroup)) nameFilter = `数字 ${state.artistGroup.slice(-1)}`;
  else if (groupLabels[state.artistGroup]) nameFilter = groupLabels[state.artistGroup];
  const postFilter = korean && state.artistPostBand !== 'all'
    ? state.artistPostBand === 'unknown' ? '作品数 · 未统计'
      : `作品数 · ${number.format(state.artistPostBand)}–${number.format(Number(state.artistPostBand) + 99)}`
    : '';
  const activeFilters = [];
  if (nameFilter) activeFilters.push({
    label: nameFilter,
    clear: () => { state.artistGroup = 'all'; },
  });
  if (postFilter) activeFilters.push({
    label: postFilter,
    clear: () => { state.artistPostBand = 'all'; },
  });
  if (state.artistShuffle) activeFilters.push({
    label: '随机顺序',
    clear: () => { state.artistShuffle = 0; },
  });
  else if (korean && state.artistOrder === 'posts') activeFilters.push({
    label: '作品数排序',
    clear: () => { state.artistOrder = 'name'; },
  });

  const applyFilters = (change) => {
    const scrollTop = main.scrollTop;
    change();
    state.page = 0;
    render();
    main.scrollTop = scrollTop;
  };

  if (state.mode === 'online') {
    const sourceBar = node('section', 'artist-source-bar');
    const sourceLabel = node('span', 'artist-source-label', '画师来源');
    const sourceGroup = node('div', 'artist-source-switch');
    sourceGroup.setAttribute('role', 'group');
    sourceGroup.setAttribute('aria-label', '画师来源');
    const sources = [['korean', '韩国主库'], ['nax', 'NAX 补充']];
    if (state.packs.length) sources.push(['imported', '已导入']);
    for (const [id, label] of sources) sourceGroup.append(chip(label, state.artistSource === id, () => {
      if (state.artistSource === id) return;
      state.artistSource = id;
      state.model = id === 'imported' ? 'pack' : 'V5';
      state.artistShuffle = 0;
      resetPage();
      if (id === 'imported') selectPack(state.pack?.id || state.packs[0]?.id);
      else if (id === 'korean') ensureKorean();
      else if (state.hasOnline) ensureOnline();
      render();
    }));
    sourceBar.append(sourceLabel, sourceGroup);
    tools.append(sourceBar);
  }

  const panel = node('details', 'artist-filter-panel');
  panel.open = wasOpen ?? activeFilters.length > 0;
  const quick = node('section', 'artist-quick-actions');
  const quickPrimary = node('div', 'artist-quick-primary');
  const chainButton = button('画风串', 'primary compact artist-chain-quick-open', () => window.PocketApp.chain.openArtistChainWorkbench());
  chainButton.setAttribute('aria-label', '画风串');
  const mixerButton = button('随机画风工坊', 'soft compact artist-mixer-quick-open', () => window.PocketApp.chain.openMixer());
  mixerButton.setAttribute('aria-label', '打开随机画风工坊');
  const pageMixerButton = button('本页入池', 'soft compact artist-page-mixer', () => addArtistCardsToMixer(artistPageCards));
  pageMixerButton.setAttribute('aria-label', '将本页画师加入画风工坊池');
  quickPrimary.append(
    chainButton,
    mixerButton,
    pageMixerButton,
    button('其他图包', 'soft compact', () => showPackSources()),
    button(state.galleryFocus ? '退出图墙' : '全屏看图', 'soft compact', () => {
      const focus = !state.galleryFocus;
      if (focus) panel.open = false;
      setGalleryLayout(focus);
      render();
    }),
  );
  const quickCopy = button('', 'soft compact artist-chain-quick-copy', window.PocketApp.chain.copyCurrentArtistChain);
  quick.append(quickPrimary, quickCopy);
  tools.append(quick);
  window.PocketApp.chain.refreshArtistChainShortcuts();

  const summary = node('summary', 'artist-filter-summary');
  summary.append(node('span', '', '筛选与更多'),
    node('small', '', activeFilters.length ? `${activeFilters.length} 项生效` : '图包、排序、显示'));
  panel.append(summary);
  const filterGrid = node('div', 'artist-filter-grid');

  const groups = node('select', 'artist-group');
  groups.setAttribute('aria-label', '按名称开头第一位分类');
  const addOptions = (container, entries) => {
    for (const [value, label] of entries) {
      const option = node('option', '', label);
      option.value = value;
      container.append(option);
    }
  };
  addOptions(groups, [['all', '名称分类 · 全部']]);
  for (const [label, entries] of [
    ['字母 A–Z', [['letters', '全部字母'], ...Array.from(initialLetters, key => [`letter-${key}`, key])]],
    ['数字 0–9', [['digits', '全部数字'], ...Array.from(initialDigits, key => [`digit-${key}`, key]), ['digit-other', '其他数字']]],
    ['其他文字与符号', [['han', '汉字'], ['kana', '假名'], ['hangul', '韩文'], ['other-letter', '其他文字'], ['symbol', '符号']]],
  ]) {
    const group = node('optgroup');
    group.label = label;
    addOptions(group, entries);
    groups.append(group);
  }
  groups.value = pair ? `letter-${pair[1]}` : state.artistGroup;
  const changeGroup = (value) => {
    applyFilters(() => {
      state.artistGroup = value;
      state.artistShuffle = 0;
    });
  };
  groups.addEventListener('change', () => {
    changeGroup(groups.value);
  });
  const groupField = node('label', 'artist-filter-field');
  groupField.append(node('span', 'artist-filter-label', '名称开头'), groups);
  filterGrid.append(groupField);

  const firstLetter = /^letter-([A-Z])$/.exec(groups.value);
  if (firstLetter) {
    const letter = firstLetter[1];
    const prefixes = node('select', 'artist-group artist-prefix');
    prefixes.setAttribute('aria-label', `按名称开头前两位筛选（${letter}）`);
    addOptions(prefixes, [[`letter-${letter}`, `${letter} 全部`],
      ...Array.from(initialLetters + initialDigits, (key) => [`letter-${letter}${key}`, `${letter}${key}`])]);
    prefixes.value = pair ? `letter-${pair[1]}${pair[2]}` : `letter-${letter}`;
    prefixes.addEventListener('change', () => changeGroup(prefixes.value));
    const prefixField = node('label', 'artist-filter-field');
    prefixField.append(node('span', 'artist-filter-label', '双字母'), prefixes);
    filterGrid.append(prefixField);
  }
  if (korean) {
    const bands = state.korean ? state.koreanPostBands : [];
    const postCounts = options([['all', '全部作品数'],
      ...bands.map(band => [band, band === 'unknown' ? '未统计'
        : `${number.format(band)}–${number.format(Number(band) + 99)}`])], state.korean ? state.artistPostBand : 'all');
    postCounts.className = 'artist-group';
    postCounts.disabled = !state.korean;
    postCounts.setAttribute('aria-label', '作品数分档');
    postCounts.setAttribute('aria-describedby', 'artist-post-band-note');
    postCounts.addEventListener('change', () => {
      applyFilters(() => { state.artistPostBand = postCounts.value; });
    });
    const postField = node('label', 'artist-filter-field');
    postField.append(node('span', 'artist-filter-label', '作品数'), postCounts);
    filterGrid.append(postField);

    const sortControls = node('div', 'artist-sort-controls');
    sortControls.setAttribute('aria-label', '画师排序');
    sortControls.append(
      chip('名称优先', state.artistOrder === 'name' && !state.artistShuffle, () => {
        applyFilters(() => {
          state.artistOrder = 'name';
          state.artistShuffle = 0;
        });
      }),
      chip('作品数优先', state.artistOrder === 'posts' && !state.artistShuffle, () => {
        applyFilters(() => {
          state.artistOrder = state.artistOrder === 'posts' && !state.artistShuffle ? 'name' : 'posts';
          state.artistShuffle = 0;
        });
      }),
    );
    const sortField = node('div', 'artist-filter-field artist-filter-field-wide');
    sortField.append(node('span', 'artist-filter-label', '排序'), sortControls);
    filterGrid.append(sortField);
    const note = node('p', 'artist-filter-note muted', '原库作品数供热度参考，可和名称分类、搜索一起筛选。');
    note.id = 'artist-post-band-note';
    filterGrid.append(note);
  }
  const utilities = node('div', 'artist-panel-tools');
  utilities.setAttribute('aria-label', '画师浏览工具');
  const draw = button('随机发现', 'soft compact', openArtistDrawScreen);
  draw.disabled = !artistDrawSourceReady();
  draw.title = draw.disabled ? '当前画师来源加载完成后可用' : '从选定的画师池发现最多十位画师';
  utilities.append(draw, button('换一批', 'soft compact', () => {
    state.artistShuffle = (Math.random() * 0xffffffff >>> 0) || 1;
    applyFilters(() => {});
  }));
  if (!state.galleryFocus) utilities.append(button('外站找图', 'soft compact', () => showTagGalleries(query.value)));
  if (state.galleryFocus) {
    const columnsGroup = node('div', 'artist-gallery-columns');
    columnsGroup.setAttribute('aria-label', '图墙列数');
    for (const columns of [2, 3, 4]) {
      columnsGroup.append(chip(`${columns} 列`, state.galleryColumns === columns, () => {
        if (state.galleryColumns === columns) return;
        setGalleryLayout(true, columns);
        render();
      }));
    }
    tools.append(columnsGroup);
  }
  filterGrid.append(utilities);
  if (state.artistShuffle) {
    filterGrid.append(button('恢复名称排序', 'text-button artist-filter-restore', () => {
      applyFilters(() => { state.artistShuffle = 0; });
    }));
  }
  for (const group of panelSections) {
    group.classList.add('artist-panel-section');
    filterGrid.append(group);
  }
  if (state.mode === 'online') {
    const resourceActions = node('div', 'artist-panel-section artist-resource-actions');
    resourceActions.id = 'artist-resource-actions';
    filterGrid.append(resourceActions);
  }
  panel.append(filterGrid);
  tools.append(panel);

  if (activeFilters.length) {
    const status = node('div', 'artist-filter-status');
    status.setAttribute('aria-label', '已生效筛选');
    status.setAttribute('aria-live', 'polite');
    status.append(node('span', 'artist-filter-status-label', '已生效'));
    for (const item of activeFilters) {
      const remove = button(`${item.label} ×`, 'active-filter', () => applyFilters(item.clear));
      remove.setAttribute('aria-label', `清除${item.label}筛选`);
      status.append(remove);
    }
    status.append(button('清除全部', 'text-button artist-filter-clear-all', () => {
      applyFilters(() => {
        state.artistGroup = 'all';
        if (korean) state.artistPostBand = 'all';
        state.artistOrder = 'name';
        state.artistShuffle = 0;
      });
    }));
    tools.append(status);
  }
}

function renderCharacterFilters(target) {
  const panel = node('details', 'character-filters');
  panel.open = Object.values(state.characterFilters).some(Boolean);
  panel.append(node('summary', '', '按作品、服装、性别或类型筛选'));
  const cards = state.mode === 'personal' ? state.personal : (state.online || []);
  for (const [key, label] of characterFields) {
    const values = new Set(cards.filter(card => card.section === 'character').map(card => card[key]).filter(Boolean));
    const choices = [['', '全部'], [' ', '未标注'], ...[...values].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(value => [value, value])];
    const select = options(choices, state.characterFilters[key] || '');
    select.addEventListener('change', () => {
      state.characterFilters[key] = select.value;
      resetPage();
      renderList();
    });
    panel.append(field(label, select));
  }
  target.append(panel);
}

function render() {
  if (state.tagGalleryReturn && (state.tagGalleryReturn.section !== state.section
      || state.tagGalleryReturn.mode !== state.mode)) {
    state.tagGalleryReturn = null;
  }
  const current = sections[state.section];
  const artistBrowser = state.section === 'artist';
  main.classList.toggle('artist-browser', artistBrowser);
  document.querySelector('.shell').classList.toggle('artist-mode', artistBrowser);
  if (!artistBrowser) {
    const listMeta = byId('list-meta');
    for (const id of ['resource-tabs', 'filters', 'view-options']) {
      const group = byId(id);
      if (group.parentNode !== main) main.insertBefore(group, listMeta);
      group.classList.remove('artist-panel-section');
    }
  }
  byId('eyebrow').textContent = 'NOVELAI / 掌上词库';
  byId('title').textContent = state.section === 'artist' ? '画师库' : current.label;
  byId('subtitle').textContent = current.subtitle;
  byId('personal').setAttribute('aria-pressed', String(state.mode === 'personal'));
  byId('online').setAttribute('aria-pressed', String(state.mode === 'online'));
  byId('online').textContent = state.section === 'knowledge' ? '知识与资源' : '在线资源';
  query.placeholder = state.section === 'knowledge' ? '搜动作、标题或提示词'
    : state.section === 'character' ? '搜角色、作品或服装' : `搜索${current.type}`;
  document.querySelectorAll('#nav button').forEach((el) => {
    if (el.dataset.section === state.section) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  const filters = byId('filters');
  filters.replaceChildren();
  const resourceTabs = byId('resource-tabs');
  resourceTabs.replaceChildren();
  if (state.section === 'artist' && state.mode === 'online') {
    const entryGroup = node('div', 'resource-entry-group');
    entryGroup.setAttribute('role', 'group');
    entryGroup.setAttribute('aria-label', '其他画师图包入口');
    if (window.Pocket || desktopApp) {
      entryGroup.append(
        button('在线社区画风', 'soft compact', () => showRemoteSharedStylePack()),
        button('自定义图库', 'soft compact', () => showOnlinePack()),
      );
    }
    appendGalleryPackEntries(entryGroup);
    if (entryGroup.childElementCount) resourceTabs.append(entryGroup);
  }
  if (state.section === 'character' && state.mode === 'online') {
    const entryGroup = node('div', 'resource-entry-group');
    entryGroup.setAttribute('role', 'group');
    entryGroup.setAttribute('aria-label', '同人角色标签图站入口');
    entryGroup.append(button('外站找图',
      'soft compact', () => showTagGalleries(query.value)));
    resourceTabs.append(entryGroup);
  }
  if (state.section === 'knowledge') {
    if (state.mode === 'online') {
      for (const [value, label] of [['basic', '中文知识'], ['images', '在线图鉴'], ['references', '原帖资料']]) {
        resourceTabs.append(chip(label, state.knowledgeTab === value, () => {
          state.knowledgeTab = value;
          state.kind = 'all';
          resetPage();
          if (state.hasOnline && isRemote()) ensureOnline();
          render();
        }));
      }
    }
    const visibleKinds = state.mode === 'online' && state.knowledgeTab === 'images'
      ? knowledgeKinds.filter(([id]) => ['all', 'hair', ...(state.model === 'V4.5' ? ['expression'] : [])].includes(id))
      : knowledgeKinds;
    for (const [value, label] of visibleKinds) {
      filters.append(chip(label, state.kind === value, () => {
        state.kind = value;
        resetPage();
        render();
      }));
    }
  }
  if (isRemote() || (state.mode === 'online' && state.section !== 'knowledge')) {
    const models = isKorean() || (state.section === 'artist' && state.artistSource === 'imported') ? [] : ['V5', 'V4.5'];
    for (const model of models) {
      (state.section === 'knowledge' ? resourceTabs : filters).append(chip(model === 'pack' ? '已导入' : model, state.model === model, () => {
        if (model === 'pack') {
          selectPack(state.pack?.id || state.packs[0]?.id);
        } else {
          state.model = model;
          state.kind = 'all';
          resetPage();
          if (isRemote() && state.hasOnline) ensureOnline();
          render();
        }
      }));
    }
    if (state.model === 'pack' && state.packs.length > 1) {
      const picker = node('select', 'source-select');
      picker.setAttribute('aria-label', '选择已导入的数据包');
      for (const pack of state.packs) {
        const option = node('option', '', pack.name);
        option.value = pack.id;
        picker.append(option);
      }
      picker.value = state.pack?.id ?? '';
      picker.addEventListener('change', () => selectPack(picker.value));
      filters.append(picker);
    }
  }
  if (isKorean()) {
    const picker = options([['all', '韩国全部图包'], ...koreanPacks], state.koreanPack);
    picker.className = 'source-select';
    picker.setAttribute('aria-label', '选择韩国画师图包');
    picker.addEventListener('change', () => {
      state.koreanPack = picker.value;
      state.korean = null;
      state.koreanStatus = '';
      resetPage();
      ensureKorean();
      render();
    });
    filters.append(picker);
  }
  if (state.section === 'character') renderCharacterFilters(filters);
  if (state.section !== 'artist' || state.mode !== 'online') appendGalleryPackEntries(resourceTabs);
  const viewOptions = byId('view-options');
  viewOptions.replaceChildren(node('span', '', '显示'));
  for (const [value, label] of [['grid', artistBrowser ? '图片' : '双列看图'], ['list', '图文列表'], ['compact', '紧凑文字']]) {
    viewOptions.append(chip(label, views[state.section] === value, () => {
      views[state.section] = value;
      writeJsonStorage('pocket-views', views);
      render();
    }));
  }
  renderArtistDiscovery();
  renderList();
}

function empty(title, message, ...buttons) {
  const panel = node('section', 'empty');
  const mark = node('div', 'row-mark');
  mark.append(icon(sections[state.section].icon));
  panel.append(mark, node('h2', '', title), node('p', '', message), ...buttons);
  results.append(panel);
}

const previews = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    previews.unobserve(img);
    img.src = img.dataset.src;
  }
}, { root: main, rootMargin: '80px 0px' });

function thumbnail(card, grid, eager = false, compact = false) {
  const box = node('span', grid ? 'card-photo' : 'row-photo');
  const placeholder = node('span', 'preview-placeholder');
  placeholder.append(icon(sections[card.section].icon));
  const caption = node('span', '', card.photos.length ? '加载预览' : '暂无配图');
  if (!compact) placeholder.append(caption);
  box.append(placeholder);
  if (card.photos.length) {
    const img = node('img', 'preview-image');
    img.alt = card.title + ' 样图';
    img.decoding = 'async';
    img.dataset.src = card.photos[0].url;
    img.onload = () => { placeholder.remove(); img.classList.add('loaded'); };
    img.onerror = () => { caption.textContent = '预览暂不可用'; img.remove(); };
    box.append(img);
    if (eager) img.src = img.dataset.src;
    else previews.observe(img);
  }
  return box;
}

function artistPictureTitleParts(title) {
  const value = String(title ?? '').normalize('NFKC').trim();
  const match = /^(.*?)\s*[\(（]([^()（）]+)[\)）]\s*$/.exec(value);
  return match && match[1].trim()
    ? { title: match[1].trim(), subtitle: match[2].trim() }
    : { title: value, subtitle: '' };
}

function row(card, options = {}) {
  const view = options.view || (state.galleryFocus ? 'grid' : views[state.section]);
  const grid = options.grid ?? view === 'grid';
  const item = node('article', grid ? 'card' : 'row');
  const artistPicture = grid && card.section === 'artist' && !options.actions;
  const artistTicket = !grid && card.section === 'artist' && !options.actions;
  if (artistPicture) item.classList.add('artist-picture-card');
  if (artistTicket) item.classList.add('artist-ticket-row');
  const hit = button(card.title, grid ? 'card-main' : 'row-main', options.open || (() => showCard(card)));
  hit.setAttribute('aria-label', card.title);
  const mark = node('span', 'row-mark');
  mark.append(icon(sections[card.section].icon));
  const text = node('span', 'row-text');
  const caption = card.section === 'knowledge'
    ? [knowledgeKinds.find(([key]) => key === card.kind)?.[1] || '通用写法', card.prompt || card.source]
    : [card.work, card.outfit, card.model, card.source || (card.photos.length ? '有配图' : '自建')];
  if (Number.isSafeInteger(card.postCount)) caption.push(`原库 ${number.format(card.postCount)} 条`);
  if (artistPicture) {
    const displayTitle = artistPictureTitleParts(card.title);
    const fact = Number.isSafeInteger(card.postCount) ? `${number.format(card.postCount)} 作品` : card.source || card.model;
    text.append(node('span', 'row-title', displayTitle.title));
    const subtitle = [displayTitle.subtitle ? `（${displayTitle.subtitle}）` : '', fact].filter(Boolean).join(' · ');
    if (subtitle) text.append(node('span', 'artist-card-meta', subtitle));
  } else {
    text.append(node('span', 'row-title', card.title), node('span', 'row-caption', caption.filter(Boolean).join(' · ')));
  }
  if (isDanbooruTagFavorite(card)) {
    item.classList.add('danbooru-tag-favorite');
    tagDictionaryAppend(text, card.prompt);
  }
  if (card.section === 'knowledge' && card.note && view !== 'compact') text.append(node('span', 'row-note', card.note));
  const media = view === 'compact' || (view === 'list' && !card.photos.length)
    ? mark : thumbnail(card, grid, options.eager, artistPicture);
  if (artistTicket) {
    const stub = node('span', 'artist-ticket-stub');
    stub.setAttribute('aria-hidden', 'true');
    hit.replaceChildren(stub, media, text);
  } else hit.replaceChildren(media, text);
  item.append(hit);
  if (options.actions) item.append(options.actions);
  else {
    if (artistPicture) {
      const tools = node('div', 'artist-card-tools');
      tools.setAttribute('role', 'group');
      tools.setAttribute('aria-label', `${card.title} 快捷操作`);
      if (state.mode !== 'personal' && !card.local) tools.append(favoriteControl(card, true));
      if (card.prompt && options.trailing !== false) {
        const copyControl = button(`复制 ${card.title}`, 'icon-button artist-card-copy', () => copy(card.prompt), 'copy');
        copyControl.title = '复制原标签';
        tools.append(copyControl);
      }
      if (tools.childElementCount) item.append(tools);
      if (options.trailing !== false && !card.prompt) {
        const viewControl = node('div', 'card-actions');
        viewControl.append(button(`查看 ${card.title}`, 'icon-button', () => showCard(card), 'arrow'));
        item.append(viewControl);
      }
    } else {
      const controls = node('div', 'card-actions');
      if (state.mode !== 'personal' && !card.local) {
        controls.append(favoriteControl(card, false));
      }
      if (options.trailing !== false && !state.galleryFocus) {
        if (card.prompt) controls.append(button(`复制 ${card.title}`, 'icon-button', () => copy(card.prompt), 'copy'));
        else controls.append(button(`查看 ${card.title}`, 'icon-button', () => showCard(card), 'arrow'));
      }
      if (controls.childElementCount) {
        item.append(controls);
      }
    }
  }
  if ((artistPicture || artistTicket) && card.prompt && !state.galleryFocus) {
    const mix = button('+ 画风串', 'soft compact artist-ticket-mix', () => {
      window.PocketApp.chain.openArtistChainWorkbench({
        defaultModel: artistModelSeries(card.model) || null, initialArtists: [card],
      });
    });
    mix.setAttribute('aria-label', `将 ${card.title} 加入画风串`);
    item.append(mix);
  }
  return item;
}

function renderList() {
  previews.disconnect();
  artistPageCards = [];
  const meta = byId('list-meta');
  meta.replaceChildren();
  const resourceActions = byId('artist-resource-actions');
  resourceActions?.replaceChildren();
  results.replaceChildren();
  if (state.tagGalleryReturn && (state.tagGalleryReturn.section !== state.section
      || state.tagGalleryReturn.mode !== state.mode)) {
    state.tagGalleryReturn = null;
  }
  if (state.tagGalleryReturn) {
    const savedReturn = state.tagGalleryReturn;
    const returnControl = button(savedReturn.label || '返回图站/来源', 'soft compact', () => {
      if (state.tagGalleryReturn === savedReturn) state.tagGalleryReturn = null;
      returnControl.remove();
      savedReturn.back();
    });
    meta.append(returnControl);
  }
  const personal = state.mode === 'personal';
  const knowledge = state.section === 'knowledge';
  const korean = isKorean();
  const pack = !personal && state.section === 'artist' && state.artistSource === 'imported';
  const remote = isRemote();
  if (korean) {
    const label = state.koreanPack === 'all' ? '精选、33000-Q 和 55000-Q' : koreanPacks.find(([id]) => id === state.koreanPack)?.[1];
    if (!state.korean || state.koreanStatus) {
      results.append(node('p', 'resource-note', state.koreanStatus || `韩国原版 V5 · ${label} · 正在读取画师目录。`));
    }
    const check = button(state.koreanChecking ? '检查中…' : '检查韩国原库更新', 'text-button', checkKorean);
    check.disabled = state.koreanChecking;
    (resourceActions || meta).append(check);
    if (!state.korean) {
      empty(state.koreanError ? '主库目录读取失败' : '正在打开韩国主库', '可在「筛选与更多」里切换图包。', ...(state.koreanError ? [button('重试', 'soft', () => { ensureKorean(); renderList(); })] : []));
      return;
    }
  }
  if (!personal && knowledge) {
    const description = state.knowledgeTab === 'images'
      ? '在线图鉴目前包含发型和表情。目录与画师、角色共用，检查会同步这份小目录。图片按需加载。'
      : state.knowledgeTab === 'references'
        ? '这里是官方指南和韩国社区原帖入口，点开后可查看来源。'
        : '中文基础说明和可复制示例，可加入自己的词库继续编辑。入门知识随应用版本更新。';
    results.append(node('p', 'resource-note', description));
    if (state.mode === 'online' && state.knowledgeTab === 'references') {
      const codex = node('section', 'codex-entry');
      codex.append(
        button('法典图鉴 · 打开原站', 'soft compact codex-entry-link', () => openLink(codexAtlasUrl)),
        node('p', 'codex-entry-note', '在原站看图并复制提示词，再回随机画风工坊粘贴。'),
      );
      results.append(codex);
    }
  }
  if (!personal && state.section === 'artist' && window.Pocket) {
    const importer = button(state.importing ? '导入中…' : '导入图包或 ZIP', 'text-button', importPack);
    importer.disabled = state.importing;
    (resourceActions || meta).append(importer);
  }
  if (remote && state.online) {
    const label = state.section === 'knowledge' ? '检查知识图鉴更新' : state.section === 'artist' ? '检查画师资源更新' : '检查角色资源更新';
    const update = button(state.onlineTask ? '检查中…' : label, 'text-button', () => ensureOnline(true));
    update.disabled = Boolean(state.onlineTask);
    (resourceActions || meta).append(update);
  }
  if (!personal && (state.importing || (pack && state.packMessage))) {
    meta.prepend(node('span', '', state.packMessage));
    if (pack && !state.packRows.length) return;
  }
  if (personal && state.personalError) {
    empty('词库暂时无法打开', '请重试读取本机保存的条目。', button('重试', 'soft', loadPersonal));
    return;
  }
  if (remote && !state.online) {
    if (state.onlineError) {
      empty('目录暂时加载失败', '检查网络后重试。已收藏的文字可以离线使用。', button('重新加载', 'soft', () => {
        ensureOnline();
        renderList();
      }));
    } else if (state.onlineTask) {
      empty('正在加载在线目录', '首次读取约 1.25 MB，图片在滑动到附近时按需读取。');
    } else {
      empty('下载在线目录', '约 1.25 MB，包含画师、角色和发型表情目录。下载后即可看图浏览，也可切换紧凑文字节省流量。',
        button('下载目录', 'primary', () => ensureOnline()));
    }
    return;
  }
  const source = personal ? state.personal : korean ? state.korean : remote ? state.online : knowledge
    ? (state.knowledgeTab === 'references' ? PocketSources.references : PocketSources.knowledge)
    : state.packRows;
  const postBand = korean ? state.artistPostBand : 'all';
  const terms = cardSearchTerms(query.value, state.section);
  const matching = source.filter((card) => {
    if (card.section !== state.section || (remote && card.model !== state.model)) return false;
    if (knowledge && state.kind !== 'all' && card.kind !== state.kind) return false;
    if (!matchesArtistGroup(card, state.artistGroup)) return false;
    if (!matchesPostCountBand(card, postBand)) return false;
    if (state.section === 'character' && !characterFields.every(([key]) => {
      const filter = state.characterFilters[key];
      return !filter || (filter === ' ' ? !card[key] : card[key] === filter);
    })) return false;
    return matchesCardSearch(card, terms);
  });
  if (state.section === 'artist' && state.artistShuffle) shuffleArtists(matching, state.artistShuffle);
  else if (korean && state.artistOrder === 'posts') matching.sort((a, b) => (b.postCount ?? -1) - (a.postCount ?? -1));
  meta.prepend(node('span', '', `${number.format(matching.length)} 条`));
  if (!matching.length) {
    state.page = 0;
    if (terms.length || state.artistGroup !== 'all' || postBand !== 'all' || (knowledge && state.kind !== 'all') ||
        (state.section === 'character' && Object.values(state.characterFilters).some(Boolean))) {
      const clear = button('清除筛选', 'soft', () => {
        state.artistGroup = 'all';
        if (korean) state.artistPostBand = 'all';
        state.artistShuffle = 0;
        state.kind = 'all';
        state.characterFilters = {};
        resetResults();
      });
      const manual = terms.length
        ? button('手动收藏此标签', 'soft', () => showManualTagEditor(query.value, state.section))
        : null;
      empty('没有匹配的条目',
        postBand === 'all' ? '换个名称分类，或试试更短的关键词。' : '试试其他作品数分档、名称分类或更短的关键词。',
        clear, ...(manual ? [manual] : []));
    }
    else if (personal) empty('从一条常用词开始', '保存后随时搜索、编辑或复制。', button('新增条目', 'soft', () => showEditor()), button('看看在线资源', 'subtle', () => chooseMode('online')));
    else empty('这里还没有条目', knowledge && remote ? '在线图鉴目前只有发型和表情；V5 暂无表情图库。可切换模型或进入中文知识查看其他分类。' : '可以切换分类，或重新导入已有数据包。');
    return;
  }
  const capacity = resultPageSize();
  const pages = Math.ceil(matching.length / capacity);
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * capacity;
  function move(target) {
    if (target < 0 || target >= pages || target === state.page) return;
    state.page = target;
    renderList();
    main.scrollTop = 0;
  }
  if (pages > 1 && state.section !== 'artist') results.append(pageJump(state.page, pages, move));
  const list = node('div', state.galleryFocus ? `gallery gallery-${state.galleryColumns} dense-gallery`
    : views[state.section] === 'grid' ? 'gallery' : 'list');
  const visibleCards = matching.slice(start, start + capacity);
  if (state.section === 'artist') artistPageCards = visibleCards;
  list.append(...visibleCards.map((card, index) => row(card, { eager: index < 8 })));
  results.append(list);
  if (pages > 1) results.append(pageSteps(state.page, pages, move));
  if (pages > 1 && state.section === 'artist') results.append(pageJump(state.page, pages, move));
  if (remote) {
    const info = node('p', 'source-info', '在线图库 · NAX / Carlyone · CC BY 4.0。');
    info.append(button('来源', 'text-button', () => openLink(PocketSources.nax)));
    results.append(info);
  } else if (korean) {
    const info = node('p', 'source-info', '感谢 bequiet / baqu2213 的原版画师库。在线检查仅核对原文件是否变化，目录新版目前随应用发布。');
    info.append(button('查看原帖', 'text-button', () => openLink('https://arca.live/b/aiart/185691299')));
    results.append(info);
  }
}

let screenBack = null;
let screenRevision = 0;

function openScreen(title, back = null, wide = false) {
  screenRevision++;
  screenBack = back;
  document.querySelector('.screen-inner')?.classList.remove('artist-chain-open');
  screen.classList.remove('artist-chain-screen');
  screen.classList.remove('artist-mixer-screen');
  screen.classList.remove('theme-open');
  screen.classList.toggle('detail-wide', wide);
  byId('screen-title').textContent = title;
  body.replaceChildren();
  actions.replaceChildren();
  if (!screen.open) screen.showModal();
  body.scrollTop = 0;
}

function closeScreen() {
  screenRevision++;
  screenBack = null;
  screen.close();
  body.replaceChildren();
  actions.replaceChildren();
  window.PocketApp.chain.refreshArtistChainShortcuts();
}

function goBack() {
  if (screenBack) screenBack();
  else closeScreen();
}

function showThemePicker() {
  openScreen('选择配色');
  screen.classList.add('theme-open');
  const palette = node('div', 'theme-palette');
  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', '界面配色');
  for (const [theme, { name }] of themeChoices) {
    const choice = button(name, 'theme-choice', () => {
      applyTheme(theme, { persist: true });
      for (const item of palette.children) item.setAttribute('aria-pressed', String(item === choice));
    });
    choice.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === theme));
    const swatch = node('span', 'theme-swatch');
    swatch.dataset.palette = theme;
    swatch.setAttribute('aria-hidden', 'true');
    choice.prepend(swatch);
    palette.append(choice);
  }
  body.append(palette);
}

function appendCopyFact(list, label, value, missing, includeEmpty = false) {
  const exists = includeEmpty ? value !== undefined : value != null && value !== '';
  if (!exists && !missing) return;
  const copyValue = value === '' && includeEmpty ? '""' : value;
  const text = exists ? (typeof copyValue === 'string' ? copyValue : JSON.stringify(copyValue)) : missing;
  const detail = node('dd', 'copy-fact');
  detail.append(node('span', exists ? '' : 'muted', text));
  if (exists) {
    const control = button('复制', 'text-button copy-fact-button', () => copy(copyValue));
    control.setAttribute('aria-label', '复制' + label);
    detail.append(control);
  }
  list.append(node('dt', '', label), detail);
}

function canReadPhotoMetadata(url) {
  return typeof url === 'string' && (
    /^\/nax-image\/[a-z0-9.-]+\/[^/?#]+(?:\?rev=[^#]*)?$/.test(url)
    || /^\/pack-image\/[a-zA-Z0-9-]+\/\d+\/\d+$/.test(url)
    || /^\/korean-image\/(?:(?:33000|55000)\/)?\d+\/\d+$/.test(url));
}

function showPhotos(card, initialIndex = 0, detailBack = null) {
  if (!card.photos.length) return;
  const photo = node('div', 'photo');
  const metadata = node('div', 'photo-metadata');
  const label = node('span', '');
  let index = Math.min(Math.max(Number.isSafeInteger(initialIndex) ? initialIndex : 0, 0), card.photos.length - 1);
  let metadataRequest = 0;
  function show() {
    const ref = card.photos[index];
    const photoIndex = index;
    metadataRequest++;
    label.textContent = `${index + 1} / ${card.photos.length} · ${ref.label || '配图'}`;
    const status = node('span', '', '正在读取预览…');
    const img = node('img', '');
    img.alt = card.title + ' · ' + (ref.label || '配图');
    img.hidden = true;
    img.onload = () => {
      if (img.parentNode !== photo) return;
      img.hidden = false;
      status.remove();
    };
    img.onerror = () => {
      if (img.parentNode === photo) photo.replaceChildren(button('预览读取失败 · 重试', 'soft', show));
    };
    photo.replaceChildren(status, img);
    metadata.replaceChildren();
    if (canReadPhotoMetadata(ref.url) && (window.Pocket || (desktopApp && !ref.url.startsWith('/pack-image/')))) {
      const readMetadata = button('查看这张图的提示词与参数', 'soft', async () => {
        const revision = screenRevision;
        const activeRequest = ++metadataRequest;
        readMetadata.disabled = true;
        readMetadata.textContent = '正在读取提示词与参数…';
        readMetadata.setAttribute('aria-busy', 'true');
        try {
          const data = window.Pocket
            ? await native('photoMetadata', ref.url) : await readSameOriginPromptPhoto(ref.url);
          if (revision !== screenRevision || photoIndex !== index || activeRequest !== metadataRequest || readMetadata.parentNode !== metadata) return;
          if (!data || typeof data !== 'object') throw new Error('没有收到这张样图的读取结果。');
          showPromptImport(data, {
            back: () => showCard(card, photoIndex, detailBack),
            resourcePhoto: {
              title: card.title,
              label: ref.label || `样图 ${photoIndex + 1}`,
              source: card.source,
              sourceUrl: card.sourceUrl,
              preview: img.hidden ? null : img,
            },
          });
        } catch (error) {
          if (revision !== screenRevision || photoIndex !== index || activeRequest !== metadataRequest || readMetadata.parentNode !== metadata) return;
          readMetadata.disabled = false;
          readMetadata.textContent = '读取失败，点此重试';
          readMetadata.removeAttribute('aria-busy');
          toast(error?.message || '读取样图生成信息失败。');
        }
      });
      metadata.append(readMetadata);
    }
    img.src = ref.url;
  }
  const previous = button('上一张', 'icon-button', () => {
    index = (index + card.photos.length - 1) % card.photos.length;
    show();
  }, 'back');
  const next = button('下一张', 'icon-button', () => {
    index = (index + 1) % card.photos.length;
    show();
  }, 'arrow');
  previous.disabled = next.disabled = card.photos.length < 2;
  const controls = node('div', 'photo-nav');
  controls.append(previous, label, next);
  body.append(photo, controls, metadata);
  show();
}

function showCard(card, photoIndex = 0, back = null) {
  openScreen('条目详情', back);
  body.append(node('h2', '', card.title));
  const dictionaryValue = card.section === 'artist'
    ? artistChainCardTag(card) || artistCardTag(card)
    : card.prompt || card.title;
  const dictionaryTerms = card.section === 'knowledge'
    ? tagGalleryReferenceTags(dictionaryValue).map((tag) => tag.name)
    : [dictionaryValue].filter(Boolean);
  if (dictionaryTerms.length) {
    const translations = node('div', 'tag-dictionary-detail');
    translations.setAttribute('aria-label', '中文标签译名');
    for (const name of [...new Set(dictionaryTerms)].slice(0, 200)) {
      tagDictionaryAppend(translations, name);
    }
    body.append(translations);
  }
  const badges = node('div', 'badges');
  for (const value of [sections[card.section].label, card.model, card.source].filter(Boolean)) {
    badges.append(node('span', 'badge', value));
  }
  body.append(badges);
  if (card.section === 'character') {
    const facts = node('dl', 'metadata-facts');
    const fields = [['title', '名称'], ...characterFields, ['model', '模型'], ['source', '来源']];
    for (const [key, label] of fields) appendCopyFact(facts, label, card[key], '未标注');
    const profile = [...fields, ['prompt', '提示词'], ['note', '备注'], ['sourceUrl', '来源链接']]
      .filter(([key]) => card[key]).map(([key, label]) => `${label}：${card[key]}`).join('\n');
    body.append(facts);
    body.append(button('复制角色资料', 'soft compact', () => copy(profile)));
  }
  if (Number.isSafeInteger(card.postCount)) body.append(node('p', 'resource-note', `原库作品记录 ${number.format(card.postCount)} 条 · bequiet 的统计`));
  showPhotos(card, photoIndex, back);
  if (card.prompt) body.append(node('div', 'prompt', card.prompt));
  appendTagGalleryActions(body, card, back, photoIndex);
  if (card.note) {
    body.append(node('p', 'detail-note', card.note));
    if (card.section === 'character') body.append(button('复制备注', 'text-button', () => copy(card.note)));
  }
  if (card.generation) {
    const details = node('details', 'metadata-details');
    details.append(node('summary', '', '原图完整生成信息'), node('pre', 'prompt', card.generation), button('复制完整信息', 'soft', () => copy(card.generation)));
    let generation;
    try { generation = JSON.parse(card.generation); } catch { /* Keep legacy notes readable. */ }
    if (Array.isArray(generation?.characters) || Array.isArray(generation?.negativeCharacters)) {
      renderCharacterPrompts(details, generation.characters, generation.negativeCharacters);
    }
    body.append(details);
  }
  if (card.sourceUrl) {
    const credit = node('p', 'source-info', card.license ? '示例图 · Carlyone / NAX · CC BY 4.0' : '');
    credit.append(button('查看来源', 'text-button', () => openLink(card.sourceUrl)));
    body.append(credit);
  }
  if (card.prompt) actions.append(button(card.section === 'character' ? '复制此角色提示词' : '复制提示词', 'primary', () => copy(card.prompt)));
  if (card.section === 'artist') {
    actions.append(button('入池', 'soft', () => addArtistCardsToMixer([card])));
    actions.append(button('加入画风串', 'soft', () => openArtistChainWorkbench({
      defaultModel: artistModelSeries(card.model) || null,
      initialArtists: [card],
      back: () => showCard(card, photoIndex, back),
    })));
  }
  if (card.local) {
    actions.append(button('编辑', 'soft', () => showEditor(card)));
    if (card.section === 'character') actions.append(button('另存服装', 'soft', () => showEditor({ ...card, id: card.from || card.id, local: false, outfit: '' })));
  }
  else {
    actions.append(favoriteControl(card));
    actions.append(button('编辑后收藏', 'soft', () => {
      const existing = findSavedCard(card);
      if (existing) {
        const photos = mergeFavoritePhotos(card, existing.photos);
        showEditor({ ...existing, photos });
        toast('已有同一条收藏，保留原内容并补充来源样图');
      } else showEditor(card);
    }));
  }
}

function cardIdentity(card) {
  const key = [card.section, card.model || '通用', searchText(card.prompt).replace(/^artist:\s*/, '')];
  if (card.section === 'character') key.push(searchText(card.outfit));
  return JSON.stringify(key);
}

function field(label, input) {
  const wrapper = node('label', 'field');
  wrapper.append(node('span', '', label), input);
  return wrapper;
}

function textInput(tag, value, placeholder, maxLength) {
  const el = node(tag, '');
  el.value = value || '';
  el.placeholder = placeholder;
  el.maxLength = maxLength;
  return el;
}

function options(values, value) {
  const select = node('select', '');
  for (const [key, label] of values) {
    const option = node('option', '', label);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  return select;
}

async function choosePhoto() {
  if (window.Pocket) return native('pickImage');
  const input = byId('web-photo');
  return new Promise((resolve, reject) => {
    input.value = '';
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const file = input.files[0];
      if (!file || file.size > 2_000_000) {
        reject(new Error('请选择 2 MB 以内的图片。'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败。'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

function showEditor(previous, back = null, originalTag = '') {
  const section = previous?.section ?? state.section;
  const existing = Boolean(previous?.local);
  openScreen(existing ? '编辑条目' : '新增' + sections[section].label, back);
  const revision = screenRevision;
  const title = textInput('input', previous?.title, '可留空，默认取提示词的第一行', 120);
  const prompt = textInput('textarea', previous?.prompt, '输入标签、短语或整段提示词', 16000);
  const note = textInput('textarea', previous?.note, '例如适用镜头、使用心得', 8000);
  const kind = options(PocketSources.knowledgeKinds, previous?.kind ?? (state.kind !== 'all' ? state.kind : 'general'));
  const model = options([['通用', '通用'], ['V5', 'V5'], ['V4.5', 'V4.5']], ['V5', 'V4.5'].includes(previous?.model) ? previous.model : '通用');
  let photos = [...(previous?.photos ?? [])];
  const form = node('div', 'form');
  const attachments = node('div', 'photo-tools');
  const photoStatus = node('span', 'muted');
  const photoButton = button('选择图片', 'soft', async () => {
    try {
      const image = await choosePhoto();
      if (!image) return;
      photos = [{ url: image, label: '我的配图' }];
      updateAttachments();
    } catch (error) { toast(error.message); }
  });
  const remove = button('移除图片', 'text-button', () => { photos = []; updateAttachments(); });
  function updateAttachments() {
    photoStatus.textContent = photos.length ? `${photos.length} 张配图` : '配图（选填）';
    remove.hidden = !photos.length;
  }
  updateAttachments();
  attachments.append(photoStatus, photoButton, remove);
  form.append(field('名称', title), field(sections[section].type, prompt));
  const dictionaryTag = originalTag || (isDanbooruTagFavorite(previous) ? previous.prompt : '');
  if (dictionaryTag) {
    tagDictionaryAppend(form, dictionaryTag, () => revision === screenRevision);
  }
  if (section === 'knowledge') form.append(field('知识分类', kind));
  const characterInputs = {};
  if (section === 'character') {
    for (const [key, label] of characterFields) {
      const current = previous?.[key] || '';
      const input = key === 'gender' ? options(genderChoices, current) : key === 'species' ? options(speciesChoices, current)
        : textInput('input', current, key === 'work' ? '填写原作名称（选填）' : '例如校服、冬装（选填）', 120);
      characterInputs[key] = input;
      form.append(field(label, input));
    }
  }
  form.append(field('适用模型', model));
  form.append(field('备注（选填）', note), attachments);
  body.append(form);
  if (previous?.generation) body.append(node('p', 'resource-note', '已附带完整原图生成信息，保存后可在条目详情查看；导出备份也会保留。'));

  const save = button('保存到我的词库', 'primary', async () => {
    if (!prompt.value.trim() && !(section === 'knowledge' && (title.value.trim() || note.value.trim()))) {
      toast('请先填写提示词或知识内容。');
      prompt.focus();
      return;
    }
    save.disabled = true;
    const card = {
      id: existing ? previous.id : (crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`),
      from: existing ? previous.from : previous?.id,
      title: title.value.trim() || (prompt.value.trim() || note.value.trim()).split('\n')[0].slice(0, 120),
      prompt: prompt.value, note: note.value, section,
      kind: section === 'knowledge' ? kind.value : undefined,
      model: model.value,
      photos, source: previous?.source, sourceUrl: previous?.sourceUrl,
      license: previous?.license, local: true, updated: Date.now(),
      generation: previous?.generation,
      ...Object.fromEntries(Object.entries(characterInputs).map(([key, input]) => [key, input.value.trim()])),
    };
    const duplicate = section !== 'knowledge' && state.personal.find((saved) => saved.id !== card.id && cardIdentity(saved) === cardIdentity(card));
    if (duplicate) { save.disabled = false; toast('该模型下已有相同标签，请编辑已有条目。'); return; }
    try {
      await useCards('readwrite', (store) => store.put(card));
      if (back) {
        await loadPersonal();
        if (revision === screenRevision) back();
        toast('已保存到我的词库');
        return;
      }
      closeScreen();
      state.section = section;
      state.mode = 'personal';
      state.kind = 'all';
      state.galleryFocus = false;
      state.characterFilters = {};
      resetResults();
      await loadPersonal();
      toast('已保存到我的词库');
    } catch {
      save.disabled = false;
      toast('保存失败，请检查手机剩余空间后重试。');
    }
  });
  if (existing) {
    actions.append(button('删除', 'subtle danger', async () => {
      if (!confirm('删除这个本机条目？')) return;
      try {
        await useCards('readwrite', (store) => store.delete(previous.id));
        if (!back) closeScreen();
        await loadPersonal();
        if (back && revision === screenRevision) back();
        toast('已删除');
      } catch { toast('删除失败，请重试。'); }
    }));
  }
  actions.append(save);
}

function toolSection(title, text) {
  const section = node('section', 'tool-section');
  section.append(node('h2', '', title), node('p', 'muted', text));
  body.append(section);
  return section;
}

async function exportBackup() {
  try {
    const cards = await useCards('readonly', (store) => store.getAll());
    const data = JSON.stringify({ format: 'nai-pocket-library', version: 1, exportedAt: new Date().toISOString(), cards });
    if (new Blob([data]).size > 20 * 1024 * 1024) throw new Error('备份超过 20 MB，请先减少自选配图。');
    if (window.Pocket) {
      if (await native('exportBackup', data)) toast('备份已导出');
    } else {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = node('a', '');
      link.href = url;
      link.download = 'NAI-pocket-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('已生成备份文件');
    }
  } catch (error) { toast(error.message || '备份失败，请重试。'); }
}

function validateBackup(raw) {
  if (typeof raw !== 'string' || new Blob([raw]).size > 20 * 1024 * 1024) throw new Error('备份文件超过 20 MB。');
  const data = JSON.parse(raw);
  if (data?.format !== 'nai-pocket-library' || data.version !== 1 || !Array.isArray(data.cards) || data.cards.length > 10000) {
    throw new Error('这不是支持的口袋词库备份。');
  }
  const ids = new Set();
  const safePhoto = (url) => typeof url === 'string' && (
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(url) || canReadPhotoMetadata(url));
  const text = (value, max, optional = true) => (optional && value === undefined) || (typeof value === 'string' && value.length <= max);
  return data.cards.map((card) => {
    if (!card || typeof card !== 'object' || !text(card.id, 500, false) || !card.id || ids.has(card.id)
      || !Object.hasOwn(sections, card.section) || !text(card.title, 400, false)
      || !text(card.prompt, 16000) || !text(card.note, 8000) || !text(card.model, 40)
      || !text(card.source, 500) || !text(card.sourceUrl, 2000) || !text(card.from, 1000) || !text(card.license, 100)
      || !text(card.work, 120) || !text(card.outfit, 120) || !text(card.gender, 30) || !text(card.species, 30)
      || !text(card.generation, 2 * 1024 * 1024) || (card.generation && new Blob([card.generation]).size > 2 * 1024 * 1024)
      || !Array.isArray(card.photos) || card.photos.length > 64
      || card.photos.some((photo) => !photo || !safePhoto(photo.url) || !text(photo.label, 200))) {
      throw new Error('备份中有无效或重复条目，未修改当前词库。');
    }
    if (card.sourceUrl && !/^https:\/\/(arca\.live|nax\.moe|gall\.dcinside\.com|docs\.novelai\.net|creativecommons\.org|huggingface\.co)(\/|$)/.test(card.sourceUrl)) {
      throw new Error('备份含有不支持的来源链接，未修改当前词库。');
    }
    ids.add(card.id);
    return {
      id: card.id, from: card.from, section: card.section, title: card.title,
      prompt: card.prompt || '', note: card.note || '', model: card.model || '通用',
      kind: PocketSources.knowledgeKinds.some(([id]) => id === card.kind) ? card.kind : 'general',
      photos: card.photos.map(({url, label}) => ({url, label})), source: card.source, sourceUrl: card.sourceUrl,
      license: card.license, local: true, updated: Number.isFinite(card.updated) ? card.updated : Date.now(),
      generation: card.generation,
      work: card.work, outfit: card.outfit, gender: card.gender, species: card.species,
    };
  });
}

async function restoreCards(cards, replace) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('cards', 'readwrite');
    const store = tx.objectStore('cards');
    if (replace) store.clear();
    for (const card of cards) store.put(card);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function importBackup() {
  try {
    let raw;
    if (window.Pocket) raw = await native('importBackup');
    else {
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.json,application/json';
      raw = await new Promise((resolve, reject) => {
        picker.oncancel = () => resolve(null);
        picker.onchange = async () => {
          const file = picker.files[0];
          if (!file) { resolve(null); return; }
          if (file.size > 20 * 1024 * 1024) { reject(new Error('备份文件超过 20 MB。')); return; }
          try { resolve(await file.text()); } catch (error) { reject(error); }
        };
        picker.click();
      });
    }
    if (raw === null) return;
    const cards = validateBackup(raw);
    openScreen('恢复个人词库');
    body.append(node('h2', '', `备份包含 ${cards.length} 条`));
    body.append(node('p', 'detail-note', '合并导入会保留当前条目，同一编号使用备份中的内容。替换恢复会清空当前个人词库，再写入备份。两种方式都不会改变在线目录。'));
    body.append(node('p', 'detail-note', '自己添加的配图随备份恢复，在线配图需要网络。导入包的配图依赖原文件位置，换机或移动文件后可能需要重新关联，备份不包含完整原包。'));
    const restore = async (replace) => {
      if (replace && !confirm('用备份替换当前个人词库？建议先导出现有内容。')) return;
      actions.querySelectorAll('button').forEach((el) => { el.disabled = true; });
      try {
        await restoreCards(cards, replace);
        closeScreen();
        state.mode = 'personal';
        resetResults();
        await loadPersonal();
        toast('词库已恢复');
      } catch {
        toast('恢复失败，原词库保持不变。请检查剩余空间。');
        actions.querySelectorAll('button').forEach((el) => { el.disabled = false; });
      }
    };
    actions.append(button('合并导入', 'primary', () => restore(false)), button('替换恢复', 'subtle danger', () => restore(true)));
  } catch (error) { toast(error instanceof SyntaxError ? '文件不是有效的 JSON 备份。' : error.message || '无法读取备份。'); }
}

let updateOffer = null;
let checkingAutomaticUpdate = false;

function rememberUpdate(info) {
  if (info?.available) updateOffer = info;
  else if (info?.status === 'current') updateOffer = null;
  const notice = byId('update-notice');
  notice.hidden = !updateOffer;
  notice.replaceChildren();
  if (updateOffer) {
    const label = updateOffer.downloaded ? '新版已准备好' : '发现新版';
    notice.append(node('span', '', `${label} ${updateOffer.latestVersion || ''}`),
      button(updateOffer.downloaded ? '安装更新' : '查看更新', 'soft compact', () => showTools(updateOffer)));
  }
}

async function checkAutomaticUpdate() {
  if (!window.Pocket || checkingAutomaticUpdate) return;
  checkingAutomaticUpdate = true;
  try { rememberUpdate(await native('checkAutomaticUpdate')); }
  catch { /* Manual checking remains available when automatic checking fails. */ }
  finally { checkingAutomaticUpdate = false; }
}

function showDesktopGallery() {
  openScreen('图库');
  const tools = node('div', 'tool-actions');
  tools.append(button('其他图包', 'primary', () => showPackSources(showDesktopGallery)),
    button('选择原图', 'soft', readImagePrompts),
    button('Danbooru 图库', 'soft', () => showTagGalleries('', showDesktopGallery, 'danbooru')));
  body.append(tools);
}

function showTools(initialUpdate) {
  openScreen('设置与工具');
  const image = toolSection('导入原图生成信息', desktopApp
    ? '选择 PNG、WebP 或 JPEG 原图，在电脑上查看和复制图片中保存的生成参数。'
    : '选择 NovelAI 保存的 PNG 或 WebP 原图，逐项复制提示词和生成参数。也可保存小预览和生成信息到图库。');
  image.append(button('选择原图', 'primary', readImagePrompts));
  const codex = toolSection('法典图鉴',
    '在原站看图并复制提示词，再回随机画风工坊粘贴。');
  const codexActions = node('div', 'tool-actions');
  codexActions.append(button('法典图鉴 · 打开原站', 'soft', () => openLink(codexAtlasUrl)),
    button('打开随机画风工坊', 'soft', () => window.PocketApp.chain.openMixer({ back: () => showTools(initialUpdate) })));
  codex.append(codexActions);
  const tagGallery = toolSection('外站图库连接', '配置 App 内图库的 API 凭据。也可以从图库直接打开官网。');
  if (window.Pocket) {
    tagGallery.append(button('管理连接与凭据', 'soft', () => {
      if (typeof window.showTagGalleryCredentials === 'function') window.showTagGalleryCredentials();
      else toast('图库连接设置尚未载入，请重新打开 App。');
    }));
  } else {
    tagGallery.append(node('p', 'detail-note', desktopApp
      ? 'Danbooru 使用公开接口。需要登录的页面可在浏览器中打开。'
      : '浏览器预览不保存图库凭据，请在 Android App 中配置。'));
  }
  const dictionary = toolSection('中文标签词典',
    '下载约 25 MB 的 ffdkj 丹波鲁中英词典，在 D 站标签、词库原词、参考标签和画风串旁显示中文译名。复制时使用原始标签。');
  dictionary.append(button(window.Pocket || desktopApp ? '打开词典安装与管理' : '查看词典说明', window.Pocket || desktopApp
    ? 'soft' : 'subtle', () => showTagDictionarySettings(() => showTools(initialUpdate))));
  const backup = toolSection('个人词库备份', '备份收藏、自己写的条目和自选配图。图库原图请单独保留，换机后可重新导入。');
  const backupActions = node('div', 'tool-actions');
  backupActions.append(button('导出备份', 'soft', exportBackup), button('从备份恢复', 'soft', importBackup));
  backup.append(backupActions);
  if (window.Pocket) {
    const cache = toolSection('在线图包缓存', '浏览过的在线图片存入临时缓存。超过 24 小时未使用或达到容量上限时，优先清理旧图。手动下载的原图保存在你选的位置。');
    const cacheStatus = node('p', 'detail-note', '正在读取缓存信息…');
    cacheStatus.setAttribute('aria-live', 'polite');
    const cacheLimit = options([['0', '关闭（0 MB）'], ['128', '128 MB'], ['256', '256 MB（默认）'],
      ['512', '512 MB'], ['1024', '1024 MB'], ['2048', '2 GB'], ['4096', '4 GB']], '256');
    const cacheActions = node('div', 'tool-actions');
    const cacheClear = button('清除缓存', 'soft', () => runCacheAction(
      'clearPackCache', null, '在线图包缓存已清除'));
    const cacheRevision = screenRevision;
    let cacheInfo = null;
    let cacheBusy = false;
    const cacheMegabytes = (bytes) => number.format(
      Math.round((Math.max(0, Number(bytes) || 0) / (1024 * 1024)) * 10) / 10);
    const applyCacheInfo = (info) => {
      if (!info || typeof info !== 'object') throw new Error('没有收到缓存信息。');
      const limitMiB = Number(info.limitMiB);
      const bytes = Number(info.bytes);
      if (!Number.isFinite(limitMiB) || !Number.isFinite(bytes)) throw new Error('缓存信息格式不正确。');
      cacheInfo = { limitMiB, bytes };
      cacheLimit.value = String(limitMiB);
      cacheStatus.textContent = `当前已用 ${cacheMegabytes(bytes)} MB / 上限 ${number.format(limitMiB)} MB`;
    };
    const runCacheAction = async (action, value, successMessage) => {
      if (cacheBusy) return;
      cacheBusy = true;
      cacheLimit.disabled = cacheClear.disabled = true;
      const revision = screenRevision;
      try {
        const info = await native(action, value);
        if (revision !== screenRevision) return;
        applyCacheInfo(info);
        toast(successMessage);
      } catch (error) {
        if (revision !== screenRevision) return;
        if (cacheInfo) cacheLimit.value = String(cacheInfo.limitMiB);
        toast(error?.message || '在线图包缓存操作失败，请重试。');
      } finally {
        if (revision === screenRevision) {
          cacheBusy = false;
          cacheLimit.disabled = cacheClear.disabled = false;
        }
      }
    };
    cacheLimit.addEventListener('change', () => runCacheAction(
      'setPackCacheLimit', cacheLimit.value, '在线图包缓存上限已更新'));
    cacheActions.append(cacheClear);
    cache.append(field('缓存上限', cacheLimit), cacheActions, cacheStatus);
    cacheLimit.disabled = cacheClear.disabled = true;
    native('packCacheInfo').then((info) => {
      if (cacheRevision !== screenRevision) return;
      applyCacheInfo(info);
    }).catch((error) => {
      if (cacheRevision !== screenRevision) return;
      cacheStatus.textContent = '暂时无法读取缓存信息。';
      toast(error?.message || '读取在线图包缓存信息失败。');
    }).finally(() => {
      if (cacheRevision === screenRevision) cacheLimit.disabled = cacheClear.disabled = false;
    });
  }
  const update = toolSection('应用版本更新', desktopApp
    ? 'Windows 便携版更新时下载并解压新版 ZIP。'
    : '打开 App 时自动检查并下载新版。下载后校验长度、签名和版本，由你在安卓系统中确认安装。');
  const version = node('p', 'detail-note', '正在读取版本…');
  const repo = textInput('input', '', 'owner/repo 或 GitHub 仓库链接', 300);
  const result = node('div', 'update-result');
  result.setAttribute('aria-live', 'polite');
  const controls = node('div', 'tool-actions');
  const displayUpdate = (info) => {
    rememberUpdate(info);
    result.replaceChildren(node('p', '', info.downloadError || info.message));
    if (info.body) result.append(node('p', 'release-notes', info.body));
    if (info.downloaded) {
      result.append(button('安装已校验的更新', 'primary', async () => {
        try {
          if (await native('installAppUpdate') === 'permission') {
            result.prepend(node('p', '', '首次需要在系统页允许本 App 安装更新。返回后再点一次安装。'));
          }
        } catch (error) { toast(error.message); }
      }));
    } else if (info.available && info.downloadUrl) {
      const download = button('在 App 内下载新版', 'primary', async () => {
        download.disabled = true;
        result.prepend(node('p', '', '正在下载并校验安装包…'));
        try { displayUpdate(await native('downloadAppUpdate')); }
        catch (error) { result.replaceChildren(node('p', '', error.message)); }
        finally { download.disabled = false; }
      });
      result.append(download);
    }
    if (info.releaseUrl) result.append(button('查看发布页', 'text-button', () => native('openAppRelease', 'release').catch((error) => toast(error.message))));
  };
  const saveRepo = button('保存地址', 'soft', async () => {
    try {
      const info = await native('setUpdateRepository', repo.value.trim());
      repo.value = info.repository;
      updateOffer = null;
      rememberUpdate(null);
      result.replaceChildren(node('p', '', info.repository ? '仓库地址已保存，可以检查新版。' : '尚未配置发布仓库。'));
    } catch (error) { toast(error.message); }
  });
  const check = button('检查应用更新', 'primary', async () => {
    check.disabled = true;
    result.replaceChildren(node('p', '', '正在检查 GitHub 发布版本…'));
    try {
      displayUpdate(await native('checkAppUpdate'));
    } catch (error) { result.replaceChildren(node('p', '', error.message)); }
    finally { check.disabled = false; }
  });
  controls.append(saveRepo, check);
  update.append(version, field('GitHub 发布仓库', repo), controls, result);
  if (window.Pocket) native('appInfo').then((info) => {
    version.textContent = '当前版本 ' + info.versionName;
    repo.value = info.repository || '';
    const automatic = checkOption('每天自动检查并下载更新', info.autoUpdate, async (enabled) => {
      try {
        await native('setAutoUpdate', String(enabled));
        if (enabled) checkAutomaticUpdate();
      } catch (error) { toast(error.message); }
    });
    version.after(automatic);
    if (!info.repository) result.append(node('p', '', '发布仓库尚未配置，当前无法检查新版。'));
  }).catch((error) => { version.textContent = error.message; });
  else {
    if (desktopApp) {
      getJson('/api/desktop.json').then((info) => {
        version.textContent = info?.version ? `当前 Windows 版本 ${info.version}` : 'Windows 便携版';
      }).catch(() => { version.textContent = 'Windows 便携版'; });
      repo.closest('.field')?.remove();
      controls.replaceChildren(button('打开 Windows 下载页', 'soft', () =>
        openLink('https://github.com/oju706/nai-pocket-library/tree/main/release')));
    } else {
      version.textContent = '当前为浏览器预览，安卓 App 中可检查版本。';
      saveRepo.disabled = check.disabled = true;
    }
  }
  const thanks = toolSection('来源与感谢', '感谢韩国 Arca Live 社区作者 bequiet / baqu2213 分享原版画师库和查看器；感谢 Carlyone 的 NAX 图库、ffdkj 的丹波鲁中英词典（MIT），以及韩国社区和 NovelAI 官方资料。');
  thanks.append(button('原版画师资源', 'text-button', () => openLink('https://arca.live/b/aiart/185691299')),
    button('NAX · CC BY 4.0', 'text-button', () => openLink(PocketSources.nax)),
    button('ffdkj 词典 · MIT', 'text-button', () => openLink(
      'https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table')));
  if (initialUpdate?.available || updateOffer?.available) {
    displayUpdate(initialUpdate?.available ? initialUpdate : updateOffer);
    if (initialUpdate?.available) update.scrollIntoView({ block: 'start' });
  }
}

byId('tools').addEventListener('click', showTools);
byId('gallery').addEventListener('click', () => {
  if (desktopApp) showDesktopGallery();
  else showGallery();
});
byId('add').addEventListener('click', () => showEditor());
byId('theme-trigger').addEventListener('click', showThemePicker);
byId('artist-dock-open').addEventListener('click', () => window.PocketApp.chain.openArtistChainWorkbench());
byId('artist-dock-copy').addEventListener('click', window.PocketApp.chain.copyCurrentArtistChain);
byId('close').addEventListener('click', goBack);
byId('personal').addEventListener('click', () => chooseMode('personal'));
byId('online').addEventListener('click', () => chooseMode('online'));
byId('nav').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-section]');
  if (tab) chooseSection(tab.dataset.section);
});
const renderQueryList = debounce(renderList, 80);
query.addEventListener('input', () => {
  resetPage();
  renderQueryList();
});
screen.addEventListener('cancel', (event) => { event.preventDefault(); goBack(); });
screen.addEventListener('click', (event) => {
  if (event.target === screen && (screen.classList.contains('theme-open') || screen.classList.contains('artist-chain-screen'))) goBack();
});
window.PocketBack = () => {
  if (screen.open) { goBack(); return true; }
  if (state.galleryFocus) { setGalleryLayout(false); render(); return true; }
  if (state.mode === 'online') { chooseMode('personal'); return true; }
  return false;
};
window.PocketForeground = checkAutomaticUpdate;

state.galleryPacks = readCachedGalleryPacks() || galleryPacksFallback;
ensureKorean();
render();
loadGalleryPacks();
loadPersonal();
loadPacks();
checkForSavedDirectory();
checkAutomaticUpdate();
