'use strict';

const byId = (id) => document.getElementById(id);
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
const galleryPacksFallback = [{
  id: 'korean-gallery',
  title: '韩国画风图库',
  section: 'artist',
  address: 'oju706/nai-pocket-library',
  defaultRating: 'unknown',
}];
const state = {
  section: 'artist', mode: 'online', model: 'V5', kind: 'all', knowledgeTab: 'basic', artistSource: 'korean',
  page: 0, online: null, onlineTask: null, onlineError: false, hasOnline: false,
  personal: [], personalError: false, packs: [], pack: null, packRows: [],
  packMessage: '', importing: false, importingRemote: false,
  galleryPacks: readCachedGalleryPacks() || galleryPacksFallback,
  artistGroup: 'all', galleryFocus: false, galleryColumns: 4, artistShuffle: 0, artistOrder: 'name',
  artistPostBand: 'all', koreanPostBands: [],
  characterFilters: {},
  koreanPack: 'all', korean: null, koreanTask: null, koreanError: false, koreanChecking: false, koreanStatus: '',
};
const koreanPacks = [['curated', 'Curated 精选'], ['33000', '33000-Q'], ['55000', '55000-Q']];
const koreanCatalogs = new Map();
const artistDrawBatchSize = 10;
const artistDrawStoragePrefix = 'pocket-artist-draw-v1';
const artistChainLegacyStorageKey = 'pocket-artist-chain-v1';
const artistChainStorageKey = 'pocket-artist-chain-v2';
const artistChainModels = ['V5', 'V4.5'];
const artistChainCapacity = 256;
const artistChainCopiesPerModel = 8;
const artistChainCopyNameMaxLength = 32;
const artistDrawPoolConfig = [
  {
    id: 'filtered',
    label: () => '当前筛选',
    rule: (context) => `filter:${JSON.stringify(context.filterKey)}`,
    cards: (context) => context.matching,
  },
  {
    id: 'all',
    label: () => '当前来源全部',
    rule: () => 'all',
    cards: (context) => context.cards,
  },
  {
    id: 'post-band',
    label: (item) => item.band === 'unknown' ? '作品数 · 未统计'
      : `作品数 · ${number.format(item.band)}–${number.format(Number(item.band) + 99)}`,
    items: (context) => context.korean
      ? context.postBands.map((band) => ({ band, key: `post-band:${band}` }))
      : [],
    rule: (_context, item) => `post:${item.band}`,
    cards: (context, item) => context.cards.filter((card) => matchesPostCountBand(card, item.band)),
  },
];
let artistDrawSession = null;
const knowledgeKinds = [['all', '全部'], ...PocketSources.knowledgeKinds];
const characterFields = [['work', '作品'], ['outfit', '服装／版本'], ['gender', '性别'], ['species', '类型']];
const genderChoices = [['', '未标注'], ['女性', '女性'], ['男性', '男性'], ['其他', '其他']];
const speciesChoices = [['', '未标注'], ['人类', '人类'], ['人外', '人外'], ['其他', '其他']];
let views = { artist: 'grid', character: 'grid', knowledge: 'list' };
try {
  const saved = JSON.parse(localStorage.getItem('pocket-views') || '{}');
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

function artistDrawSourceReady() {
  if (state.section !== 'artist' || state.mode !== 'online') return false;
  if (isKorean()) return Array.isArray(state.korean) && !state.koreanTask;
  if (state.artistSource === 'nax') return Array.isArray(state.online) && !state.onlineTask;
  if (state.artistSource === 'imported') return Boolean(state.pack) && Array.isArray(state.packRows) && !state.packMessage;
  return false;
}

function artistDrawContext() {
  if (!artistDrawSourceReady()) return null;
  const korean = isKorean();
  let cards;
  let sourceId;
  let sourceLabel;
  let postBands = [];
  if (korean) {
    cards = state.korean.filter((card) => card.section === 'artist');
    sourceId = `korean:${state.koreanPack}`;
    sourceLabel = state.koreanPack === 'all' ? '韩国全部图包'
      : `韩国 · ${koreanPacks.find(([id]) => id === state.koreanPack)?.[1] || state.koreanPack}`;
    postBands = state.koreanPostBands;
  } else if (state.artistSource === 'nax') {
    cards = state.online.filter((card) => card.section === 'artist' && card.model === state.model);
    sourceId = `nax:${state.model}`;
    sourceLabel = `NAX · ${state.model}`;
  } else {
    cards = state.packRows.filter((card) => card.section === 'artist');
    sourceId = `imported:${state.pack.id}`;
    sourceLabel = `已导入 · ${state.pack.name}`;
  }
  const terms = cardSearchTerms(query.value, 'artist');
  const postBand = korean ? state.artistPostBand : 'all';
  const matching = cards.filter((card) => {
    if (!matchesArtistGroup(card, state.artistGroup) || !matchesPostCountBand(card, postBand)) return false;
    return matchesCardSearch(card, terms);
  });
  const filterKey = {
    keywords: [...new Set(terms)].sort(),
    group: state.artistGroup,
    postBand,
  };
  return {
    cards, matching, sourceId, sourceLabel, korean, postBands,
    filterKey, key: JSON.stringify({ sourceId, filterKey }),
  };
}

function artistDrawPoolOptions(context) {
  return artistDrawPoolConfig.flatMap((definition) => {
    const items = definition.items ? definition.items(context) : [null];
    return items.map((item) => ({
      key: item?.key || definition.id,
      label: definition.label(item),
      ruleKey: definition.rule(context, item),
      cards: () => definition.cards(context, item),
    }));
  });
}

function artistDrawHistoryKey(context, pool) {
  return [artistDrawStoragePrefix, context.sourceId, pool.ruleKey]
    .map((part) => encodeURIComponent(part)).join(':');
}

function readArtistDrawHistory(context, pool) {
  try {
    const values = JSON.parse(localStorage.getItem(artistDrawHistoryKey(context, pool)) || '[]');
    return new Set(Array.isArray(values) ? values.map((value) => searchText(value)).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeArtistDrawHistory(context, pool, seen) {
  try {
    localStorage.setItem(artistDrawHistoryKey(context, pool), JSON.stringify([...seen]));
  } catch { /* The current session still de-duplicates when storage is unavailable. */ }
}

function uniqueArtistDrawCards(cards) {
  const unique = new Map();
  for (const card of cards) {
    const tag = artistDrawTag(card);
    if (!tag) continue;
    const current = unique.get(tag);
    if (!current || (card.photos?.length || 0) > (current.photos?.length || 0)) unique.set(tag, card);
  }
  return [...unique.values()];
}

function sampleArtistDrawCards(cards, count) {
  const size = Math.min(count, cards.length);
  for (let index = 0; index < size; index++) {
    const other = index + Math.floor(Math.random() * (cards.length - index));
    [cards[index], cards[other]] = [cards[other], cards[index]];
  }
  return cards.slice(0, size);
}

function shuffleArtists(cards, seed) {
  let random = seed;
  for (let i = cards.length - 1; i > 0; i--) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const other = random % (i + 1);
    [cards[i], cards[other]] = [cards[other], cards[i]];
  }
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
    const saved = JSON.parse(localStorage.getItem(galleryPacksStorageKey) || 'null');
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
      try {
        localStorage.setItem(galleryPacksStorageKey,
          JSON.stringify({ format: 'nai-pocket-gallery-index', version: 1, packs }));
      } catch { /* The built-in entry remains available. */ }
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

function openLink(url) {
  if (window.Pocket) native('openLink', url).catch((error) => toast(error.message));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function tagGalleryButtons(getTag) {
  const links = node('div', 'tag-gallery-actions');
  for (const gallery of PocketSources.tagGalleries) {
    links.append(button(`${gallery.label} ↗`, 'soft compact', () => {
      openLink(PocketSources.tagGallerySearchUrl(gallery.id, getTag()));
    }));
  }
  return links;
}

function showTagGalleries(initialTag = '', back = null) {
  openScreen('外站找图', back);
  const input = textInput('input', '', '例如 yyy_(zelda10010)', 512);
  input.value = initialTag;
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const section = toolSection('按标签搜索', '选一个图站，在浏览器查看结果。留空可打开帖子列表。');
  section.append(field('一个完整的画师或角色标签', input), tagGalleryButtons(() => input.value));
}

function appendTagGalleryActions(target, card) {
  if (!['artist', 'character'].includes(card.section)) return;
  const value = card.section === 'artist' ? artistChainCardTag(card) || artistCardTag(card)
    : card.local ? card.title : card.prompt || card.title;
  const tag = PocketSources.tagGalleryTag(value);
  if (!tag) return;
  const section = node('section', 'tag-gallery-search');
  section.append(node('h3', '', '外站找图'), tagGalleryButtons(() => tag));
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

function showPackSources() {
  openScreen('其他图包');

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
  quickPrimary.append(button('画风串', 'primary compact', () => openArtistChainWorkbench()));
  quickPrimary.append(button('其他图包', 'soft compact', showPackSources));
  quickPrimary.append(button(state.galleryFocus ? '退出图墙' : '全屏看图', 'soft compact', () => {
    const focus = !state.galleryFocus;
    if (focus) panel.open = false;
    setGalleryLayout(focus);
    render();
  }));
  quick.append(quickPrimary);
  tools.append(quick);

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
    if (window.Pocket) {
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
      try { localStorage.setItem('pocket-views', JSON.stringify(views)); } catch { /* In-memory choice still works. */ }
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

function row(card, options = {}) {
  const view = options.view || (state.galleryFocus ? 'grid' : views[state.section]);
  const grid = options.grid ?? view === 'grid';
  const item = node('article', grid ? 'card' : 'row');
  const artistPicture = grid && card.section === 'artist' && !options.actions;
  if (artistPicture) item.classList.add('artist-picture-card');
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
    const fact = Number.isSafeInteger(card.postCount) ? `${number.format(card.postCount)} 作品` : card.source || card.model;
    text.append(node('span', 'row-title', card.title));
    if (fact) text.append(node('span', 'artist-card-meta', fact));
  } else {
    text.append(node('span', 'row-title', card.title), node('span', 'row-caption', caption.filter(Boolean).join(' · ')));
  }
  if (card.section === 'knowledge' && card.note && view !== 'compact') text.append(node('span', 'row-note', card.note));
  hit.replaceChildren(view === 'compact' || (view === 'list' && !card.photos.length)
    ? mark : thumbnail(card, grid, options.eager, artistPicture), text);
  item.append(hit);
  if (options.actions) item.append(options.actions);
  else {
    const controls = node('div', 'card-actions');
    if (state.mode !== 'personal' && !card.local) {
      const favorite = favoriteControl(card, artistPicture);
      if (artistPicture) item.append(favorite);
      else controls.append(favorite);
    }
    if (options.trailing !== false && !state.galleryFocus && (!artistPicture || card.prompt)) {
      if (card.prompt) controls.append(button(`复制 ${card.title}`, 'icon-button', () => copy(card.prompt), 'copy'));
      else controls.append(button(`查看 ${card.title}`, 'icon-button', () => showCard(card), 'arrow'));
    }
    if (controls.childElementCount) {
      if (artistPicture) item.classList.add('artist-picture-copy');
      item.append(controls);
    }
  }
  return item;
}

function renderList() {
  previews.disconnect();
  const meta = byId('list-meta');
  meta.replaceChildren();
  const resourceActions = byId('artist-resource-actions');
  resourceActions?.replaceChildren();
  results.replaceChildren();
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
      empty('没有匹配的条目', postBand === 'all' ? '换个名称分类，或试试更短的关键词。' : '试试其他作品数分档、名称分类或更短的关键词。', button('清除筛选', 'soft', () => {
        state.artistGroup = 'all';
        if (korean) state.artistPostBand = 'all';
        state.artistShuffle = 0;
        state.kind = 'all';
        state.characterFilters = {};
        resetResults();
      }));
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
  list.append(...matching.slice(start, start + capacity).map((card, index) => row(card, { eager: index < 8 })));
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

function artistDrawPool(session) {
  return session.pools.find((pool) => pool.key === session.poolKey) || session.pools[0];
}

function drawNextArtistBatch(session) {
  const pool = artistDrawPool(session);
  const unique = uniqueArtistDrawCards(pool.cards());
  const seen = new Set([...readArtistDrawHistory(session.context, pool), ...session.seen]);
  const available = unique.filter((card) => !seen.has(artistDrawTag(card)));
  const batch = sampleArtistDrawCards(available, artistDrawBatchSize);
  for (const card of batch) seen.add(artistDrawTag(card));
  writeArtistDrawHistory(session.context, pool, seen);
  session.seen = seen;
  session.batch = batch;
  session.totalUnique = unique.length;
  session.remaining = available.length - batch.length;
  session.exhausted = available.length === 0 || batch.length >= available.length;
  session.hasDrawn = true;
}

function artistDrawCard(card) {
  const controls = node('div', 'card-actions');
  controls.append(favoriteControl(card));
  return row(card, {
    grid: true,
    view: 'grid',
    eager: true,
    trailing: false,
    open: () => showCard(card, 0, renderArtistDrawScreen),
    actions: controls,
  });
}

function renderArtistDrawScreen() {
  const session = artistDrawSession;
  if (!session) return;
  openScreen('随机发现画师');
  const pool = artistDrawPool(session);
  body.append(node('p', 'resource-note',
    `${session.context.sourceLabel} · 每批最多 ${artistDrawBatchSize} 位。同一个池会跳过已展示的画师。`));
  const pools = options(session.pools.map(({ key, label }) => [key, label]), session.poolKey);
  pools.addEventListener('change', () => {
    session.poolKey = pools.value;
    session.seen = new Set();
    drawNextArtistBatch(session);
    renderArtistDrawScreen();
  });
  body.append(field('画师池', pools));
  if (session.batch.length) {
    const gallery = node('div', 'gallery');
    gallery.append(...session.batch.map(artistDrawCard));
    body.append(gallery);
    if (session.exhausted) {
      body.append(node('p', 'resource-note', '这是本池最后一批。可以重置本池记录后再浏览。'));
    }
  } else {
    const panel = node('section', 'empty');
    const mark = node('div', 'row-mark');
    mark.append(icon('artist'));
    panel.append(mark,
      node('h2', '', session.totalUnique ? '这个池已经看完' : '这个池没有可浏览的画师'),
      node('p', '', session.totalUnique
        ? `本池的 ${number.format(session.totalUnique)} 位画师都已出现过。重置只清除「${pool.label}」的历史，不会删除收藏。`
        : '换一个画师池，或回到画师列表调整筛选。'));
    body.append(panel);
  }
  if (session.totalUnique && session.exhausted) {
    actions.append(button('重置本池浏览记录', 'soft', resetArtistDrawPool));
  } else if (session.remaining > 0) {
    actions.append(button(`再看 ${Math.min(artistDrawBatchSize, session.remaining)} 位`, 'primary', () => {
      drawNextArtistBatch(session);
      renderArtistDrawScreen();
    }));
  }
}

function resetArtistDrawPool() {
  const session = artistDrawSession;
  if (!session) return;
  const pool = artistDrawPool(session);
  if (!confirm(`重置「${pool.label}」中已出现的画师记录，并重新抽取？收藏不会被删除。`)) return;
  try {
    localStorage.removeItem(artistDrawHistoryKey(session.context, pool));
  } catch { /* A fresh in-memory session can still continue. */ }
  session.seen = new Set();
  session.batch = [];
  session.hasDrawn = false;
  drawNextArtistBatch(session);
  renderArtistDrawScreen();
}

function openArtistDrawScreen() {
  const context = artistDrawContext();
  if (!context) {
    toast('当前画师来源尚未加载完成。');
    return;
  }
  const pools = artistDrawPoolOptions(context);
  const previous = artistDrawSession;
  const sameContext = previous?.context.key === context.key;
  if (sameContext) {
    previous.context = context;
    previous.pools = pools;
    if (!pools.some((pool) => pool.key === previous.poolKey)) previous.poolKey = pools[0].key;
    if (!previous.hasDrawn) drawNextArtistBatch(previous);
  } else {
    const poolKey = context.filterKey.keywords.length || context.filterKey.group !== 'all'
      || context.filterKey.postBand !== 'all' ? 'filtered' : 'all';
    artistDrawSession = {
      context, pools, poolKey,
      seen: new Set(), batch: [],
      totalUnique: 0, remaining: 0, exhausted: false, hasDrawn: false,
    };
    drawNextArtistBatch(artistDrawSession);
  }
  renderArtistDrawScreen();
}

let screenBack = null;
let screenRevision = 0;

function openScreen(title, back = null, wide = false) {
  screenRevision++;
  screenBack = back;
  document.querySelector('.screen-inner')?.classList.remove('artist-chain-open');
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
}

function goBack() {
  if (screenBack) screenBack();
  else closeScreen();
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
    if (window.Pocket && canReadPhotoMetadata(ref.url)) {
      const readMetadata = button('查看这张图的提示词与参数', 'soft', async () => {
        const revision = screenRevision;
        const activeRequest = ++metadataRequest;
        readMetadata.disabled = true;
        readMetadata.textContent = '正在读取提示词与参数…';
        readMetadata.setAttribute('aria-busy', 'true');
        try {
          const data = await native('photoMetadata', ref.url);
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
  appendTagGalleryActions(body, card);
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

function showEditor(previous) {
  const section = previous?.section ?? state.section;
  const existing = Boolean(previous?.local);
  openScreen(existing ? '编辑条目' : '新增' + sections[section].label);
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
        closeScreen();
        await loadPersonal();
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

async function readImagePrompts() {
  if (!window.Pocket) { toast('请在安卓 App 中选择原图。'); return; }
  const revision = screenRevision;
  try {
    const data = await native('readImagePrompts');
    if (!data || revision !== screenRevision) return;
    showPromptImport(data);
  } catch (error) { toast(error.message || '读取原图失败。'); }
}

function checkOption(label, checked, change) {
  const wrapper = node('label', 'option-check');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => change(input.checked));
  wrapper.append(input, node('span', '', label));
  return wrapper;
}

function selectedGeneration(data, selected) {
  const actual = selected.actual;
  const prompt = selected.positive ? (actual && data.actualPrompt || data.prompt || '') : '';
  const negativePrompt = selected.negative ? (actual && data.actualNegativePrompt || data.negativePrompt || '') : '';
  const characters = selected.characters ? (actual && data.actualCharacters?.length ? data.actualCharacters : data.characters || []) : [];
  const negativeCharacters = selected.characters ? (actual && data.actualNegativeCharacters?.length ? data.actualNegativeCharacters : data.negativeCharacters || []) : [];
  const parameters = selected.settings ? { ...data.parameters } : {};
  for (const key of ['prompt', 'uc', 'negative_prompt', 'v4_prompt', 'v4_negative_prompt', 'actual_prompts', 'Comment', 'seed']) delete parameters[key];
  if (selected.seed && data.parameters?.seed !== undefined) parameters.seed = data.parameters.seed;
  const withCaptions = (original, base, rows) => original && selected.characters
    ? { ...original, caption: { base_caption: base, char_captions: rows } } : undefined;
  return {
    prompt, negativePrompt, characters, negativeCharacters, parameters,
    model: selected.settings ? data.model : undefined,
    promptMode: actual ? 'actual' : 'original',
    v4Prompt: withCaptions(data.v4Prompt, prompt, characters),
    v4NegativePrompt: withCaptions(data.v4NegativePrompt, negativePrompt, negativeCharacters),
  };
}

const verifiedModelHashes = new Map([
  ['0ADF9AB7', 'V5 Full'],
  ['657484A5', 'V5 Full'],
  ['70AB5786', 'V5 Full Medium'],
  ['93F4BD30', 'V5 Full Medium'],
  ['DB276663', 'V5 精选'],
  ['4BDE2A90', 'V4.5 Full'],
  ['1229B44F', 'V4.5 Full'],
  ['B9F340FD', 'V4.5 Full'],
  ['F3D95188', 'V4.5 Full'],
  ['C02D4F98', 'V4.5 精选'],
]);

function novelAiModelLabel(value, hash = '') {
  const raw = typeof value === 'string' ? value.trim() : '';
  const api = /^nai-diffusion-(4-5|[345])(?:-(full|curated)(?:-(small|medium))?)?(?:-(inpainting))?$/i.exec(raw);
  const name = /^(?:novelai diffusion\s+(?:anime\s+)?)?v(4\.5|[345])(?=$|[\s(（-])/i.exec(raw);
  const version = api ? `V${api[1].replace('-', '.')}` : name ? `V${name[1]}` : '';
  const variant = api?.[2] || (name && /\b(full|curated)\b|精选/i.exec(raw)?.[0]);
  if (variant) {
    const base = variant.toLowerCase() === 'full' ? 'Full' : '精选';
    const size = api?.[3] || /\b(small|medium)\b/i.exec(raw)?.[0];
    const inpainting = api?.[4] || /\binpainting\b/i.test(raw);
    return `${version} ${base}${size ? ' ' + size[0].toUpperCase() + size.slice(1).toLowerCase() : ''}${inpainting ? ' · 局部重绘' : ''}`;
  }
  const suffix = /(?:^|\s)([a-f0-9]{8})$/i.exec(raw)?.[1];
  const known = verifiedModelHashes.get(String(suffix || hash).toUpperCase());
  if (known && (!version || known.startsWith(`${version} `))) return known;
  return version ? `${version}（型号未核实）` : '未标注';
}

const parameterLabels = {
  model: '模型', sampler: '采样器', steps: '步数', seed: '种子',
  width: '宽度', height: '高度', scale: '提示词引导（CFG）', cfg_rescale: '引导重缩放',
  noise_schedule: '噪声计划', sm: 'SMEA', sm_dyn: 'SMEA DYN',
  qualityToggle: '质量词开关', ucPreset: '负向预设',
  dynamic_thresholding: '动态阈值', strength: '强度', noise: '噪声',
};

function renderCharacterPrompts(container, characters, negatives) {
  if (!Array.isArray(characters)) characters = [];
  if (!Array.isArray(negatives)) negatives = [];
  const caption = (entry) => typeof entry === 'string' ? entry : entry?.char_caption || '';
  for (let i = 0; i < Math.max(characters.length, negatives.length); i++) {
    const title = `角色 ${i + 1}`;
    const positive = characters[i];
    const negative = negatives[i];
    const card = node('section', 'metadata-disclosure');
    const group = node('details', 'character-prompts');
    const fields = { prompt: caption(positive), negativePrompt: caption(negative) };
    if (positive?.centers?.length) fields.centers = positive.centers;
    if (negative?.centers?.length) fields.negativeCenters = negative.centers;
    const body = node('div', 'character-prompts-body');
    group.append(node('summary', '', title));
    addCopyablePrompt(body, title + '正向', fields.prompt);
    addCopyablePrompt(body, title + '负向', fields.negativePrompt);
    const positions = node('dl', 'metadata-facts');
    appendCopyFact(positions, '正向位置', fields.centers);
    appendCopyFact(positions, '负向位置', fields.negativeCenters);
    if (positions.childElementCount) body.append(positions);
    group.append(body);
    card.append(group, button('复制这位角色', 'soft compact metadata-disclosure-copy', () => copy(fields)));
    container.append(card);
  }
}

function addCopyablePrompt(container, label, value) {
  if (!value) return;
  const section = node('div', 'copyable-prompt');
  const control = button('复制' + label, 'soft compact', () => copy(value));
  const heading = node('div', 'prompt-card-heading');
  heading.append(node('h3', '', label), control);
  section.append(heading, node('div', 'prompt', value));
  container.append(section);
}

function artistTagKey(value) {
  return unescapeTagPunctuation(String(value ?? '').normalize('NFKC'))
    .replace(/[_\s]+/g, ' ').replace(/ *([()]) */g, '$1').trim().toLocaleLowerCase();
}

function unescapeTagPunctuation(value) {
  return value.replace(/\\([\\(),_])/g, '$1');
}

let artistChainDraftCache = null;
let artistChainStorageMessage = '';
let artistChainStorageUnavailable = false;

function emptyArtistChainDraft() {
  const draft = {
    format: 'nai-pocket-artist-chain',
    version: 2,
    selectedModel: 'V5',
    drafts: { V5: [], 'V4.5': [] },
    copies: { V5: [], 'V4.5': [] },
    activeCopyIds: { V5: '', 'V4.5': '' },
    compareCopyIds: { V5: null, 'V4.5': null },
    nextCopyId: 1,
  };
  for (const model of artistChainModels) {
    const copy = { id: `default-${model}`, name: '默认草稿', items: [] };
    draft.copies[model].push(copy);
    draft.drafts[model] = copy.items;
    draft.activeCopyIds[model] = copy.id;
  }
  return draft;
}

function normalizeArtistChainCopyName(value) {
  if (typeof value !== 'string') return { error: '请输入副本名称。' };
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!name) return { error: '请输入副本名称。' };
  if (name.length > artistChainCopyNameMaxLength) {
    return { error: `副本名称最多 ${artistChainCopyNameMaxLength} 个字符。` };
  }
  return { name };
}

function normalizeArtistChainItems(stored) {
  if (!Array.isArray(stored) || stored.length > artistChainCapacity) {
    throw new Error(`每个模型的画风串最多保存 ${artistChainCapacity} 位画师。`);
  }
  const items = [];
  const keys = new Set();
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.tag !== 'string' || typeof entry.weight !== 'number'
        || (entry.disabled !== undefined && typeof entry.disabled !== 'boolean')) {
      throw new Error('画风串草稿条目不正确。');
    }
    const normalized = normalizeArtistChainTag(entry.tag, { escapeCommas: true });
    if (normalized.error
        || !Number.isFinite(entry.weight) || entry.weight < 0 || entry.weight > 3
        || Math.abs(entry.weight * 10 - Math.round(entry.weight * 10)) > 1e-9
        || keys.has(normalized.key)) {
      throw new Error('画风串草稿含无效的标签、倍率或重复项。');
    }
    keys.add(normalized.key);
    items.push({
      tag: normalized.tag,
      key: normalized.key,
      weight: entry.weight,
      disabled: entry.disabled === true,
    });
  }
  return items;
}

function normalizeLegacyArtistChainDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.format !== 'nai-pocket-artist-chain' || value.version !== 1
      || !value.drafts || typeof value.drafts !== 'object' || Array.isArray(value.drafts)) {
    throw new Error('画风串草稿格式不正确。');
  }
  const result = {
    selectedModel: artistChainModels.includes(value.selectedModel) ? value.selectedModel : 'V5',
    drafts: {},
  };
  for (const model of artistChainModels) {
    result.drafts[model] = normalizeArtistChainItems(value.drafts[model]);
  }
  return result;
}

function upgradeLegacyArtistChainDraft(value) {
  const legacy = normalizeLegacyArtistChainDraft(value);
  const result = emptyArtistChainDraft();
  result.selectedModel = legacy.selectedModel;
  for (const model of artistChainModels) {
    const copy = result.copies[model][0];
    copy.items = legacy.drafts[model];
    result.drafts[model] = copy.items;
  }
  return result;
}

function normalizeArtistChainDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.format !== 'nai-pocket-artist-chain' || value.version !== 2
      || !value.copies || typeof value.copies !== 'object' || Array.isArray(value.copies)) {
    throw new Error('画风串草稿格式不正确。');
  }
  const result = emptyArtistChainDraft();
  if (artistChainModels.includes(value.selectedModel)) result.selectedModel = value.selectedModel;
  const nextCopyId = Number(value.nextCopyId);
  if (Number.isSafeInteger(nextCopyId) && nextCopyId > 0) result.nextCopyId = nextCopyId;

  for (const model of artistChainModels) {
    const storedCopies = value.copies[model];
    if (!Array.isArray(storedCopies) || !storedCopies.length
        || storedCopies.length > artistChainCopiesPerModel) {
      throw new Error(`每个模型需要保存 1–${artistChainCopiesPerModel} 份画风串草稿。`);
    }
    const copies = [];
    const ids = new Set();
    const names = new Set();
    for (const storedCopy of storedCopies) {
      if (!storedCopy || typeof storedCopy !== 'object' || Array.isArray(storedCopy)
          || typeof storedCopy.id !== 'string' || !storedCopy.id || storedCopy.id.length > 80) {
        throw new Error('画风串副本标识不正确。');
      }
      const normalizedName = normalizeArtistChainCopyName(storedCopy.name);
      if (normalizedName.error || ids.has(storedCopy.id) || names.has(normalizedName.name)) {
        throw new Error('画风串副本名称或标识不正确。');
      }
      ids.add(storedCopy.id);
      names.add(normalizedName.name);
      copies.push({
        id: storedCopy.id,
        name: normalizedName.name,
        items: normalizeArtistChainItems(storedCopy.items),
      });
    }
    const activeId = value.activeCopyIds?.[model];
    const active = copies.find((copy) => copy.id === activeId) || copies[0];
    const compareId = value.compareCopyIds?.[model];
    const compare = copies.find((copy) => copy.id === compareId && copy.id !== active.id);
    result.copies[model] = copies;
    result.activeCopyIds[model] = active.id;
    result.drafts[model] = active.items;
    result.compareCopyIds[model] = compare?.id || null;
  }
  return result;
}

function loadArtistChainDraft({ fresh = false } = {}) {
  if (artistChainDraftCache && !fresh) return artistChainDraftCache;
  artistChainStorageUnavailable = false;
  try {
    const raw = localStorage.getItem(artistChainStorageKey);
    if (raw) {
      artistChainDraftCache = normalizeArtistChainDraft(JSON.parse(raw));
      artistChainStorageMessage = '已从本机恢复画风串草稿与副本。';
    } else {
      const legacyRaw = localStorage.getItem(artistChainLegacyStorageKey);
      if (legacyRaw) {
        artistChainDraftCache = upgradeLegacyArtistChainDraft(JSON.parse(legacyRaw));
        if (persistArtistChainDraft(artistChainDraftCache)) {
          artistChainStorageMessage = '已恢复旧版草稿。';
        }
      } else {
        artistChainDraftCache = emptyArtistChainDraft();
        artistChainStorageMessage = '草稿会自动保存在本机。';
      }
    }
  } catch (error) {
    artistChainDraftCache = emptyArtistChainDraft();
    if (error instanceof SyntaxError || error?.message?.includes('草稿')) {
      artistChainStorageMessage = '本机画风串草稿格式异常，已使用空草稿。';
    } else {
      artistChainStorageUnavailable = true;
      artistChainStorageMessage = '本机存储不可用；草稿仅保留在当前会话。';
    }
  }
  return artistChainDraftCache;
}

function persistArtistChainDraft(draft) {
  const value = {
    format: draft.format,
    version: draft.version,
    selectedModel: draft.selectedModel,
    drafts: Object.fromEntries(artistChainModels.map((model) => [model, draft.drafts[model].map((item) => ({
      tag: item.tag,
      weight: item.weight,
      ...(item.disabled ? { disabled: true } : {}),
    }))])),
    copies: Object.fromEntries(artistChainModels.map((model) => [model, draft.copies[model].map((copy) => ({
      id: copy.id,
      name: copy.name,
      items: copy.items.map((item) => ({
        tag: item.tag,
        weight: item.weight,
        ...(item.disabled ? { disabled: true } : {}),
      })),
    }))])),
    activeCopyIds: { ...draft.activeCopyIds },
    compareCopyIds: { ...draft.compareCopyIds },
    nextCopyId: draft.nextCopyId,
  };
  try {
    localStorage.setItem(artistChainStorageKey, JSON.stringify(value));
    artistChainStorageUnavailable = false;
    artistChainStorageMessage = '草稿已自动保存到本机。';
    return true;
  } catch {
    artistChainStorageUnavailable = true;
    artistChainStorageMessage = '本机草稿写入失败；当前会话仍可继续使用。';
    return false;
  }
}

function inspectArtistChainTag(value) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if ((character === '"' || character === "'")
        && (index === 0 || /[\s([{:]/.test(value[index - 1]))) {
      const end = promptQuoteEnd(value, index);
      if (end !== -1) {
        index = end;
        continue;
      }
    }
    if (pairs[character]) {
      stack.push(pairs[character]);
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (stack.pop() !== character) return '括号未正确配对。';
      continue;
    }
    if (character === ',' && !stack.length) return '一次只能加入一位画师，多个顶层标签请分开添加。';
  }
  if (stack.length) return '括号未正确配对。';
  return '';
}

function normalizeArtistChainTag(value, { escapeCommas = false } = {}) {
  let tag = String(value ?? '').normalize('NFKC').trim();
  if (!tag) return { error: '请输入一位画师的完整标签。' };
  tag = tag.replace(/^artist\s*:\s*/i, '').trim();
  if ((tag[0] === '"' || tag[0] === "'") && promptQuoteEnd(tag, 0) === tag.length - 1) {
    tag = tag.slice(1, -1).trim();
  }
  if (!tag) return { error: '请补全 artist: 后面的画师标签。' };
  if (tag.length > 512 || /[\u0000-\u001f\u007f]/.test(tag)) {
    return { error: '画师标签过长或含有控制字符。' };
  }
  if (tag.includes('::')) return { error: '画风串不支持 ::，请只输入单个画师标签。' };
  if (tag.includes('|')) return { error: '画风串不支持 |，请只输入单个画师标签。' };
  if (/[\[\]{}]/.test(tag)) return { error: '画师标签不能包含 [] 或 {}。' };
  if (tag.endsWith('\\')) return { error: '画师标签末尾不能是孤立的反斜杠。' };
  if (escapeCommas) tag = artistChainEscapeCommas(tag);
  const structureError = inspectArtistChainTag(tag);
  if (structureError) return { error: structureError };
  const key = artistTagKey(tag);
  if (!key) return { error: '画师标签需要包含可识别的文字。' };
  return { tag, key };
}

function validateArtistChainInput(value, catalog, targetModel) {
  const normalized = normalizeArtistChainTag(value);
  if (normalized.error) return normalized;
  if (/(?:^|\s):\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(normalized.tag)) {
    return { error: '请只用下方的倍率控件设置权重；未确认的权重块不能加入。' };
  }
  if (/:([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/.test(normalized.tag)) {
    return { error: '请只用下方的倍率控件设置权重；未确认的权重块不能加入。' };
  }
  const candidates = catalog.index.get(normalized.key) || [];
  if (!candidates.length) {
    return { error: '未找到完整标签。可以从下方的画师搜索结果点选。' };
  }
  const identities = new Set(candidates.map(({ identity }) => identity));
  if (identities.size > 1) return { error: '这个名称对应多个完整标签，请从下方点选要加入的画师。' };
  const preferred = preferredArtistRecord(candidates, targetModel) || candidates[0];
  return { ...normalized, card: preferred.card };
}

function artistChainEscapeCommas(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === ',') {
      let slashes = 0;
      for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) slashes++;
      if (slashes % 2 === 0) result += '\\';
    }
    result += character;
  }
  return result;
}

function artistChainPrompt(items) {
  return items.filter((item) => !item.disabled).map((item) => {
    const name = `artist:${artistChainEscapeCommas(item.tag)}`;
    return item.weight === 1 ? name : `${item.weight.toFixed(1)}::${name} ::`;
  }).join(', ');
}

function activeArtistChainCopy(draft, model) {
  return draft.copies[model].find((copy) => copy.id === draft.activeCopyIds[model])
    || draft.copies[model][0];
}

function activateArtistChainCopy(draft, model, copyId) {
  const copy = draft.copies[model].find((candidate) => candidate.id === copyId);
  if (!copy) return false;
  draft.activeCopyIds[model] = copy.id;
  draft.drafts[model] = copy.items;
  if (draft.compareCopyIds[model] === copy.id) draft.compareCopyIds[model] = null;
  return true;
}

function createArtistChainCopy(draft, model, name, items) {
  const id = `copy-${model.replace(/[^A-Za-z0-9]/g, '')}-${draft.nextCopyId++}`;
  const copy = {
    id,
    name,
    items: items.map((item) => ({ tag: item.tag, key: item.key, weight: item.weight, disabled: item.disabled === true })),
  };
  draft.copies[model].push(copy);
  return copy;
}

function compareArtistChainCopies(currentItems, otherItems) {
  const current = new Map(currentItems.map((item) => [artistTagKey(item.tag), item]));
  const other = new Map(otherItems.map((item) => [artistTagKey(item.tag), item]));
  return {
    added: currentItems.filter((item) => !other.has(artistTagKey(item.tag))),
    removed: otherItems.filter((item) => !current.has(artistTagKey(item.tag))),
    weights: currentItems.flatMap((item) => {
      const match = other.get(artistTagKey(item.tag));
      return match && match.weight !== item.weight ? [{ item, other: match }] : [];
    }),
    disabled: currentItems.flatMap((item) => {
      const match = other.get(artistTagKey(item.tag));
      return match && Boolean(match.disabled) !== Boolean(item.disabled) ? [{ item, other: match }] : [];
    }),
  };
}

function enqueueArtistChainTag(draft, model, value, {
  catalog = null, targetModel = '', requireCatalog = false,
} = {}) {
  if (!draft?.drafts || !artistChainModels.includes(model) || !Array.isArray(draft.drafts[model])) {
    return { error: '画风串模型草稿不可用。' };
  }
  if (requireCatalog && !catalog) return { error: '画师目录尚未就绪，请稍候。' };
  const validated = catalog
    ? validateArtistChainInput(value, catalog, targetModel)
    : normalizeArtistChainTag(value, { escapeCommas: true });
  if (validated.error) return validated;
  let entry = validated;
  if (validated.card) {
    const canonicalTag = artistChainCardTag(validated.card);
    if (canonicalTag) {
      const canonical = normalizeArtistChainTag(canonicalTag, { escapeCommas: true });
      if (canonical.error) return canonical;
      entry = { ...canonical, card: validated.card };
    }
  }
  const items = draft.drafts[model];
  const duplicate = items.some((item) => artistTagKey(item.tag) === entry.key);
  if (duplicate) {
    return { duplicate: true, error: `「${entry.tag}」已在 ${model} 草稿中，没有重复加入。` };
  }
  if (items.length >= artistChainCapacity) {
    return {
      capacity: true,
      error: `${model} 草稿最多保存 ${artistChainCapacity} 位画师，请先移除一位再加入。`,
    };
  }
  const item = { tag: entry.tag, key: entry.key, weight: 1, disabled: false };
  items.push(item);
  return { added: true, item, tag: entry.tag, key: entry.key, card: entry.card || null };
}

function addArtistCardsToChain(cards, draft, targetModel) {
  let added = 0;
  let duplicates = 0;
  let capacity = 0;
  let invalid = 0;
  for (const card of cards) {
    const tag = artistChainCardTag(card);
    const result = enqueueArtistChainTag(draft, targetModel, tag);
    if (result.added) added++;
    else if (result.duplicate) duplicates++;
    else if (result.capacity) capacity++;
    else invalid++;
  }
  return { added, duplicates, capacity, invalid };
}

function openArtistChainWorkbench({
  back = null, defaultModel = null, initialArtists = [],
} = {}) {
  openScreen('画风串工作台', back);
  document.querySelector('.screen-inner')?.classList.add('artist-chain-open');
  const revision = screenRevision;
  let draft = loadArtistChainDraft();
  let activeModel = artistChainModels.includes(defaultModel) ? defaultModel
    : artistChainModels.includes(draft.selectedModel) ? draft.selectedModel : 'V5';
  draft.selectedModel = activeModel;
  const addition = addArtistCardsToChain(initialArtists, draft, activeModel);
  if (initialArtists.length) persistArtistChainDraft(draft);

  let koreanResults = [];
  let importedResults = [];
  let catalog = promptArtistCatalog([], { loading: true });
  let catalogLoading = true;
  const workbench = node('div', 'artist-chain-workbench');
  const intro = node('p', 'resource-note',
    'V5 与 V4.5 各有独立草稿。命名另存后可切换继续编辑；停用只影响预览与复制。');
  const modelControls = node('div', 'artist-chain-models');
  const modelButtons = new Map();
  for (const model of artistChainModels) {
    const control = chip(model, model === activeModel, () => {
      if (activeModel === model) return;
      activeModel = model;
      draft.selectedModel = model;
      persistArtistChainDraft(draft);
      setFeedback('');
      renderModelControls();
      renderCopyControls();
      renderDraft();
      renderArtistChoices();
    });
    modelButtons.set(model, control);
    modelControls.append(control);
  }
  modelControls.setAttribute('aria-label', '画风串模型草稿');

  const copiesSection = node('section', 'artist-chain-copies');
  const copiesHeading = node('div', 'artist-chain-copies-heading');
  const copyCount = node('span', 'muted');
  copiesHeading.append(node('h2', '', '当前草稿与副本'), copyCount);
  const copyToolbar = node('div', 'artist-chain-copy-toolbar');
  const currentCopyField = node('label', 'artist-chain-copy-field');
  const currentCopySelect = node('select');
  currentCopySelect.setAttribute('aria-label', '当前草稿副本');
  currentCopyField.append(node('span', '', '当前草稿'), currentCopySelect);
  const copyForm = node('div', 'artist-chain-save-copy');
  const copyNameInput = textInput('input', '', '副本名称，如：柔和线稿', artistChainCopyNameMaxLength);
  copyNameInput.setAttribute('aria-label', '新副本名称');
  const saveCopy = button('另存副本', 'soft compact', () => saveNamedCopy());
  copyForm.append(copyNameInput, saveCopy);
  copyToolbar.append(currentCopyField, copyForm);
  const copyStatus = node('p', 'artist-chain-copy-status',
    `每个模型最多 ${artistChainCopiesPerModel} 份；副本独立保存标签、顺序、倍率与停用状态。`);
  copiesSection.append(copiesHeading, copyToolbar, copyStatus);

  const layout = node('div', 'artist-chain-layout');
  const editor = node('section', 'artist-chain-editor');
  const editorHeading = node('div', 'artist-chain-heading');
  const count = node('span', 'muted');
  const refresh = button('刷新草稿', 'text-button', () => {
    if (artistChainStorageUnavailable) {
      setFeedback('本机存储不可用，当前会话草稿无法从本机刷新。', true);
      toast(artistChainStorageMessage);
      return;
    }
    const stored = loadArtistChainDraft({ fresh: true });
    draft = stored;
    draft.selectedModel = activeModel;
    renderModelControls();
    renderCopyControls();
    renderDraft();
    setFeedback('已重新载入本机草稿。');
    toast('画风串草稿已刷新');
  });
  editorHeading.append(node('h2', '', '加入画师'), count, refresh);

  const form = node('form', 'artist-chain-add');
  const input = textInput('input', '', '搜索画师名，或粘贴完整标签', 512);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', '搜索画师或输入完整标签');
  const add = button('加入', 'primary compact', () => {});
  add.type = 'submit';
  add.disabled = true;
  form.append(input, add);

  let feedbackSequence = 0;
  const feedback = node('p', 'artist-chain-feedback');
  feedback.id = `artist-chain-feedback-${++feedbackSequence}`;
  feedback.setAttribute('role', 'status');
  input.setAttribute('aria-describedby', feedback.id);
  const catalogStatus = node('p', 'artist-chain-catalog muted', '正在读取画师目录…');
  const choices = node('div', 'artist-chain-choices');
  choices.setAttribute('aria-label', '画师搜索结果');
  choices.hidden = true;
  const list = node('div', 'artist-chain-list');
  editor.append(editorHeading, form, feedback, catalogStatus, choices, list);

  const side = node('section', 'artist-chain-side');
  const previewHeading = node('div', 'artist-chain-preview-heading');
  previewHeading.append(node('h2', '', '实时预览'), node('span', 'muted', '官方倍率语法'));
  const preview = node('div', 'prompt artist-chain-preview');
  const copyButton = button('复制整串', 'primary artist-chain-copy-button', () => {
    const value = artistChainPrompt(draft.drafts[activeModel]);
    if (value) copy(value);
  });
  const saveStatus = node('p', 'artist-chain-save-status', artistChainStorageMessage || '草稿会自动保存在本机。');
  saveStatus.setAttribute('role', 'status');
  side.append(previewHeading, preview, saveStatus);
  layout.append(editor, side);

  const comparison = node('section', 'artist-chain-compare');
  const comparisonHeading = node('div', 'artist-chain-compare-heading');
  comparisonHeading.append(node('h2', '', 'A/B 比较'));
  const compareField = node('label', 'artist-chain-copy-field');
  const compareCopySelect = node('select');
  compareCopySelect.setAttribute('aria-label', '要比较的另一份草稿');
  compareField.append(node('span', '', '比较另一份'), compareCopySelect);
  comparisonHeading.append(compareField);
  const comparisonStatus = node('p', 'artist-chain-compare-status');
  comparisonStatus.setAttribute('role', 'status');
  const comparisonDiff = node('div', 'artist-chain-compare-diff');
  const comparisonGrid = node('div', 'artist-chain-compare-grid');
  comparison.append(comparisonHeading, comparisonStatus, comparisonDiff, comparisonGrid);

  workbench.append(intro, modelControls, copiesSection, layout, comparison);
  body.append(workbench);
  actions.append(copyButton);

  function setFeedback(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle('danger', error);
    feedback.setAttribute('aria-invalid', String(error));
  }

  function saveDraft() {
    persistArtistChainDraft(draft);
    saveStatus.textContent = artistChainStorageMessage;
    saveStatus.classList.toggle('danger', artistChainStorageUnavailable);
  }

  function renderModelControls() {
    for (const [model, control] of modelButtons) {
      control.setAttribute('aria-pressed', String(model === activeModel));
    }
  }

  function renderCopyControls() {
    const copies = draft.copies[activeModel];
    const activeCopy = activeArtistChainCopy(draft, activeModel);
    currentCopySelect.replaceChildren(...copies.map((copy) => {
      const option = node('option', '', `${copy.name} · ${copy.items.length} 位`);
      option.value = copy.id;
      return option;
    }));
    currentCopySelect.value = activeCopy.id;
    currentCopySelect.disabled = copies.length < 2;
    copyCount.textContent = `${copies.length} / ${artistChainCopiesPerModel} 份`;
    const atCapacity = copies.length >= artistChainCopiesPerModel;
    copyNameInput.disabled = atCapacity;
    saveCopy.disabled = atCapacity;
    copyStatus.textContent = atCapacity
      ? `当前模型的 ${artistChainCopiesPerModel} 份副本已用完；仍可切换和继续编辑现有副本。`
      : `每个模型最多 ${artistChainCopiesPerModel} 份；副本独立保存标签、顺序、倍率与停用状态。`;
    copyStatus.classList.toggle('danger', atCapacity);
  }

  function renderPreview() {
    const items = draft.drafts[activeModel];
    const value = artistChainPrompt(items);
    const enabled = items.filter((item) => !item.disabled).length;
    preview.textContent = items.length
      ? value || '所有画师均已停用；实时预览与复制为空。'
      : '尚未加入画师。';
    preview.classList.toggle('muted', !value);
    copyButton.disabled = !value;
    count.textContent = `${items.length} 位 · ${enabled} 启用`;
  }

  function comparisonCard(letter, chainCopy) {
    const card = node('article', 'artist-chain-compare-card');
    const heading = node('div', 'artist-chain-compare-card-heading');
    const enabled = chainCopy.items.filter((item) => !item.disabled).length;
    heading.append(node('h3', '', `${letter} · ${chainCopy.name}`),
      node('span', 'muted', `${enabled} / ${chainCopy.items.length} 启用`));
    const value = artistChainPrompt(chainCopy.items);
    const prompt = node('div', 'prompt artist-chain-compare-prompt',
      value || (chainCopy.items.length ? '所有画师均已停用。' : '这份草稿为空。'));
    prompt.classList.toggle('muted', !value);
    const copyAction = button(`复制 ${letter} 草稿`, 'soft compact', () => {
      if (value) copy(value);
    });
    copyAction.disabled = !value;
    card.append(heading, prompt, copyAction);
    return card;
  }

  function renderComparison() {
    const copies = draft.copies[activeModel];
    const activeCopy = activeArtistChainCopy(draft, activeModel);
    const others = copies.filter((copy) => copy.id !== activeCopy.id);
    compareCopySelect.replaceChildren();
    const noChoice = node('option', '', others.length ? '选择另一份草稿' : '暂无另一份草稿');
    noChoice.value = '';
    compareCopySelect.append(noChoice);
    for (const copy of others) {
      const option = node('option', '', copy.name);
      option.value = copy.id;
      compareCopySelect.append(option);
    }
    compareCopySelect.disabled = !others.length;
    comparisonDiff.replaceChildren();
    comparisonGrid.replaceChildren();

    if (!others.length) {
      draft.compareCopyIds[activeModel] = null;
      compareCopySelect.value = '';
      comparisonStatus.textContent = `当前模型只有「${activeCopy.name}」。另存一份副本后即可进行 A/B 比较。`;
      return;
    }
    const selectedId = draft.compareCopyIds[activeModel];
    const other = others.find((copy) => copy.id === selectedId);
    if (!other) {
      draft.compareCopyIds[activeModel] = null;
      compareCopySelect.value = '';
      comparisonStatus.textContent = '选择同模型的另一份副本后，会比较新增、移除、倍率与停用变化。';
      return;
    }
    compareCopySelect.value = other.id;
    comparisonStatus.textContent =
      `A 是当前「${activeCopy.name}」，B 是「${other.name}」；预览和复制只包含各自启用的画师。`;
    comparisonGrid.append(comparisonCard('A', activeCopy), comparisonCard('B', other));

    const changes = compareArtistChainCopies(activeCopy.items, other.items);
    const hasChanges = changes.added.length || changes.removed.length
      || changes.weights.length || changes.disabled.length;
    comparisonDiff.append(node('h3', '', '差异'));
    if (!hasChanges) {
      comparisonDiff.append(node('p', 'artist-chain-compare-same',
        '两份草稿的画师、倍率与停用状态一致。'));
      return;
    }
    const appendGroup = (title, lines) => {
      if (!lines.length) return;
      const group = node('div', 'artist-chain-compare-group');
      const list = node('ul');
      for (const line of lines) list.append(node('li', '', line));
      group.append(node('h4', '', title), list);
      comparisonDiff.append(group);
    };
    appendGroup('新增 · A 独有', changes.added.map((item) => item.tag));
    appendGroup('移除 · B 独有', changes.removed.map((item) => item.tag));
    appendGroup('倍率变化 · A → B', changes.weights.map(({ item, other: match }) =>
      `${item.tag}：${item.weight.toFixed(1)}× → ${match.weight.toFixed(1)}×`));
    appendGroup('停用变化 · A → B', changes.disabled.map(({ item, other: match }) =>
      `${item.tag}：${item.disabled ? '停用' : '启用'} → ${match.disabled ? '停用' : '启用'}`));
  }

  function renderDraft() {
    const items = draft.drafts[activeModel];
    list.replaceChildren();
    if (!items.length) {
      const empty = node('div', 'empty artist-chain-empty');
      empty.append(node('h3', '', '这份草稿还是空的'),
        node('p', '', '从画师详情、原图提示词加入，或在上面粘贴一个完整标签。'));
      list.append(empty);
    }
    items.forEach((item, index) => {
      const row = node('article', 'artist-chain-item');
      row.classList.toggle('is-disabled', Boolean(item.disabled));
      const heading = node('div', 'artist-chain-item-heading');
      heading.append(node('strong', '', item.tag),
        node('small', 'muted', `第 ${index + 1} 位${item.disabled ? ' · 已停用' : ''}`));
      const controls = node('div', 'artist-chain-item-controls');
      const up = button('上移', 'soft compact', () => {
        if (!index) return;
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
        saveDraft();
        renderDraft();
      });
      const down = button('下移', 'soft compact', () => {
        if (index >= items.length - 1) return;
        [items[index + 1], items[index]] = [items[index], items[index + 1]];
        saveDraft();
        renderDraft();
      });
      const remove = button('移除', 'text-button danger', () => {
        items.splice(index, 1);
        saveDraft();
        setFeedback(`已移除 ${item.tag}。`);
        renderDraft();
      });
      const toggle = button(item.disabled ? '恢复' : '停用',
        item.disabled ? 'soft compact' : 'text-button', () => {
          item.disabled = !item.disabled;
          saveDraft();
          setFeedback(`${item.disabled ? '已停用' : '已恢复'} ${item.tag}；顺序与倍率保持不变。`);
          renderDraft();
        });
      toggle.setAttribute('aria-label', `${item.disabled ? '恢复' : '停用'} ${item.tag}`);
      up.disabled = index === 0;
      down.disabled = index === items.length - 1;
      controls.append(up, down, toggle, remove);

      const weightGroup = node('div', 'artist-chain-weight');
      const decrease = button('−', 'icon-button', () => updateWeight(item.weight - .1));
      decrease.setAttribute('aria-label', `降低 ${item.tag} 的倍率`);
      const weight = node('input', 'artist-chain-weight-input');
      weight.type = 'number';
      weight.inputMode = 'decimal';
      weight.min = '0';
      weight.max = '3';
      weight.step = '0.1';
      weight.value = item.weight.toFixed(1);
      weight.setAttribute('aria-label', `${item.tag} 的倍率，范围 0 到 3，步长 0.1`);
      const increase = button('+', 'icon-button', () => updateWeight(item.weight + .1));
      increase.setAttribute('aria-label', `提高 ${item.tag} 的倍率`);
      const presets = node('div', 'artist-chain-weight-presets');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', `${item.tag} 的常用倍率`);
      const presetButtons = [.7, 1, 1.3, 1.5].map((value) => {
        const preset = button(`${value.toFixed(1)}×`, 'soft artist-chain-weight-preset',
          () => updateWeight(value));
        preset.setAttribute('aria-label', `将 ${item.tag} 的倍率设为 ${value.toFixed(1)}`);
        preset.setAttribute('aria-pressed', String(item.weight === value));
        presets.append(preset);
        return [value, preset];
      });
      function updateWeight(next, { syncInput = true, announce = true } = {}) {
        const numeric = Number(next);
        if (!Number.isFinite(numeric)) return;
        item.weight = Math.min(3, Math.max(0, Math.round(numeric * 10) / 10));
        if (syncInput) {
          weight.value = item.weight.toFixed(1);
          weight.removeAttribute('aria-invalid');
        }
        decrease.disabled = item.weight === 0;
        increase.disabled = item.weight === 3;
        for (const [value, preset] of presetButtons) {
          preset.setAttribute('aria-pressed', String(item.weight === value));
        }
        saveDraft();
        renderPreview();
        renderComparison();
        if (announce) setFeedback(`已将 ${item.tag} 设为 ${item.weight.toFixed(1)} 倍。`);
      }
      decrease.disabled = item.weight === 0;
      increase.disabled = item.weight === 3;
      weight.addEventListener('input', () => {
        const raw = weight.value.trim();
        if (!raw) return;
        const next = Number(raw);
        const valid = Number.isFinite(next) && next >= 0 && next <= 3
          && Math.abs(next * 10 - Math.round(next * 10)) < 1e-9;
        weight.setAttribute('aria-invalid', String(!valid));
        if (!valid) {
          setFeedback(`倍率需在 0–3 之间并按 0.1 递增；当前仍保留 ${item.weight.toFixed(1)}。`, true);
          return;
        }
        updateWeight(next, { syncInput: false });
      });
      weight.addEventListener('blur', () => {
        weight.value = item.weight.toFixed(1);
        weight.removeAttribute('aria-invalid');
      });
      weightGroup.append(decrease, weight, increase);
      row.append(heading, weightGroup, presets, controls);
      list.append(row);
    });
    renderPreview();
    renderComparison();
    saveStatus.textContent = artistChainStorageMessage;
    saveStatus.classList.toggle('danger', artistChainStorageUnavailable);
  }

  currentCopySelect.addEventListener('change', () => {
    const copy = draft.copies[activeModel].find((candidate) => candidate.id === currentCopySelect.value);
    if (!copy || !activateArtistChainCopy(draft, activeModel, copy.id)) return;
    draft.selectedModel = activeModel;
    saveDraft();
    setFeedback(`已切换到「${copy.name}」，可继续编辑。`);
    renderCopyControls();
    renderDraft();
  });

  compareCopySelect.addEventListener('change', () => {
    const copyId = compareCopySelect.value || null;
    draft.compareCopyIds[activeModel] = copyId;
    saveDraft();
    renderComparison();
  });

  function saveNamedCopy() {
    const copies = draft.copies[activeModel];
    if (copies.length >= artistChainCopiesPerModel) {
      setFeedback(`当前模型已有 ${artistChainCopiesPerModel} 份副本，无法继续另存。`, true);
      return;
    }
    const normalized = normalizeArtistChainCopyName(copyNameInput.value);
    if (normalized.error) {
      setFeedback(normalized.error, true);
      copyNameInput.focus();
      return;
    }
    if (copies.some((copy) => copy.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase())) {
      setFeedback('当前模型已有同名副本，请换一个名称。', true);
      copyNameInput.focus();
      return;
    }
    const previousCopy = activeArtistChainCopy(draft, activeModel);
    const copy = createArtistChainCopy(draft, activeModel, normalized.name, draft.drafts[activeModel]);
    activateArtistChainCopy(draft, activeModel, copy.id);
    draft.compareCopyIds[activeModel] = previousCopy.id;
    draft.selectedModel = activeModel;
    copyNameInput.value = '';
    saveDraft();
    setFeedback(`已另存并切换到「${copy.name}」；A/B 已将它和「${previousCopy.name}」比较。`);
    renderCopyControls();
    renderDraft();
    toast(`已另存副本「${copy.name}」`);
  }

  function finishArtistAddition(result) {
    if (!result.added) {
      setFeedback(result.error, true);
      input.focus();
      return;
    }
    input.value = '';
    renderArtistChoices();
    saveDraft();
    setFeedback(`已加入 ${result.tag}，默认 1.0 倍。`);
    renderDraft();
    input.focus();
  }

  function renderArtistChoices() {
    choices.replaceChildren();
    choices.hidden = true;
    const terms = cardSearchTerms(input.value, 'artist');
    if (catalogLoading || !terms.length) return;
    choices.hidden = false;
    const matches = new Map();
    for (const record of catalog.records) {
      if (!matchesCardSearch(record.card, terms)) continue;
      if (!matches.has(record.identity)) matches.set(record.identity, []);
      matches.get(record.identity).push(record);
    }
    if (!matches.size) {
      choices.append(node('p', 'muted', '当前已加载的画师目录里没有搜索结果。'));
      return;
    }
    const rank = (key) => key === terms[0] ? 0 : key.startsWith(terms[0]) ? 1 : 2;
    const ordered = [...matches].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, 'en'));
    let displayed = 0;
    for (const [, records] of ordered) {
      if (displayed === 8) break;
      const card = preferredArtistRecord(records, activeModel).card;
      const tag = artistChainCardTag(card);
      if (!tag) continue;
      displayed++;
      const row = node('div', 'pack-source');
      const label = node('div');
      label.append(node('strong', '', tag), node('small', '', [card.source, card.model].filter(Boolean).join(' · ')));
      const select = button('加入', 'soft compact', () => finishArtistAddition(enqueueArtistChainTag(draft, activeModel, tag)));
      select.setAttribute('aria-label', `加入 ${tag}`);
      row.append(label, select);
      choices.append(row);
    }
    if (!displayed) choices.append(node('p', 'muted', '匹配到的条目没有可加入的单画师标签。'));
    else if (ordered.length > 8) choices.append(node('p', 'muted', `共 ${number.format(ordered.length)} 个结果，可输入更完整的名称缩小范围。`));
  }

  let searchTimer;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    setFeedback('');
    choices.hidden = true;
    searchTimer = setTimeout(() => {
      if (revision === screenRevision) renderArtistChoices();
    }, 140);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (catalogLoading) {
      setFeedback('画师目录仍在读取，请稍候。', true);
      return;
    }
    const result = enqueueArtistChainTag(draft, activeModel, input.value, {
      catalog, targetModel: activeModel, requireCatalog: true,
    });
    finishArtistAddition(result);
    if (!result.added) renderArtistChoices();
  });

  renderCopyControls();
  renderDraft();
  function refreshArtistChoices() {
    if (revision !== screenRevision) return;
    catalog = promptArtistCatalog(koreanResults, { loading: catalogLoading, importedResults });
    if (catalogLoading) return;
    add.disabled = false;
    catalogStatus.textContent = `已载入 ${number.format(catalog.index.size)} 个完整画师标签 · ${promptArtistCatalogNote(catalog)}。`;
    renderArtistChoices();
  }
  Promise.allSettled(koreanPacks.map(([id]) => loadKoreanCatalog(id))).then((results) => {
    koreanResults = results;
    catalogLoading = false;
    refreshArtistChoices();
  }).catch(() => {
    if (revision !== screenRevision) return;
    catalogLoading = false;
    add.disabled = false;
    catalogStatus.textContent = '画师目录读取失败，暂时无法手动验证新标签。';
  });
  loadSavedNaxDirectory(revision)?.then(() => {
    if (state.online) refreshArtistChoices();
  }).catch(() => { /* The bundled and imported catalogs remain available. */ });
  loadImportedArtistCatalogs().then((results) => {
    importedResults = results;
    if (results.length) refreshArtistChoices();
  });

  if (addition.added || addition.duplicates || addition.capacity) {
    const parts = [];
    if (addition.added) parts.push(`已加入 ${addition.added} 位画师`);
    if (addition.duplicates) parts.push(`${addition.duplicates} 位已在当前草稿`);
    if (addition.capacity) parts.push(`${activeModel} 草稿已达到 ${artistChainCapacity} 位上限`);
    toast(parts.join('；'));
  }
}

function promptQuoteEnd(text, start) {
  const quote = text[start].normalize('NFKC');
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index].normalize('NFKC');
    if (character === '\\') {
      index++;
      continue;
    }
    if (character !== quote) continue;
    let nextIndex = index + 1;
    while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex++;
    const next = (text[nextIndex] || '').normalize('NFKC');
    if (!next || ',)]}:'.includes(next)) return index;
    const previous = text[index - 1].normalize('NFKC');
    if (/[\s,([{:]/.test(previous)) return -1;
  }
  return -1;
}

function splitPromptTags(value, recognizeBlocks = false) {
  const parts = [];
  let start = 0;
  let depth = 0;
  const text = String(value ?? '');
  const boundary = /(?:\\?<\/?(?:style|artist)\s*\\?>|&lt;\/?(?:style|artist)\s*&gt;)(?:\\(?=\r?\n))?|(?:\\?\r?\n)(?=[ \t]*(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*::\s*)?artist\s*:)/iy;
  for (let index = 0; index < text.length; index++) {
    const character = text[index].normalize('NFKC');
    if (recognizeBlocks && depth === 0 && /[<\\&\r\n]/.test(character)) {
      boundary.lastIndex = index;
      if (boundary.test(text)) {
        parts.push(text.slice(start, index));
        start = boundary.lastIndex;
        index = start - 1;
        continue;
      }
    }
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const previous = (text[index - 1] || '').normalize('NFKC');
      if (index === start || /[\s([{:]/.test(previous)) {
        const end = promptQuoteEnd(text, index);
        if (end !== -1) {
          index = end;
          continue;
        }
      }
    }
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character) && depth > 0) depth--;
    if (depth === 0 && character === ',') {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unwrapPromptTag(value) {
  let result = String(value ?? '').trim();
  let changed = false;
  while (result.length >= 2) {
    const opening = result[0];
    const closing = opening === '(' ? ')' : opening === '[' ? ']' : opening === '{' ? '}' : '';
    if (!closing || result[result.length - 1] !== closing) break;
    let depth = 0;
    let closesAt = -1;
    for (let index = 0; index < result.length; index++) {
      const character = result[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === opening) depth++;
      else if (character === closing) {
        depth--;
        if (depth === 0) {
          closesAt = index;
          break;
        }
      }
    }
    if (closesAt !== result.length - 1) break;
    result = result.slice(1, -1).trim();
    changed = true;
  }
  return { value: result, changed };
}

function visitPromptTag(value, original, weightedContext, output) {
  let tag = String(value ?? '').normalize('NFKC').trim();
  if (!tag) return;
  tag = tag.replace(/^::\s*/, '').trim();
  tag = tag.replace(/\s*::\s*$/, '').trim();
  if (!tag) return;
  const weightedPrefix = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*::\s*/.exec(tag);
  if (weightedPrefix) {
    let body = tag.slice(weightedPrefix[0].length).trim();
    if (body.endsWith('::')) body = body.slice(0, -2).trim();
    for (const part of splitPromptTags(body)) visitPromptTag(part, original, 'numeric', output);
    return;
  }
  const unwrapped = unwrapPromptTag(tag);
  if (unwrapped.changed) {
    const parts = splitPromptTags(unwrapped.value);
    for (const part of parts) visitPromptTag(part, original, weightedContext || 'wrapped', output);
    return;
  }
  if (weightedContext) {
    tag = tag.replace(/\s*:\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*$/, '').trim();
  }
  if (!tag) return;
  const explicit = /^artist\s*:\s*([\s\S]*)$/i.exec(tag);
  let name = (explicit ? explicit[1] : tag).trim();
  const repairColon = Boolean(explicit && weightedContext === 'numeric' && /[^:\\]:$/.test(name));
  if ((name[0] === '"' || name[0] === "'") && promptQuoteEnd(name, 0) === name.length - 1) {
    name = name.slice(1, -1).trim();
  }
  if (!name) return;
  output.push({
    explicit: Boolean(explicit),
    name: unescapeTagPunctuation(name),
    key: artistTagKey(name),
    original: original || tag,
    repairColon,
  });
}

function extractPromptTags(value) {
  const output = [];
  for (const part of splitPromptTags(value, true)) {
    const original = part.trim();
    const parsed = part.replace(/\\\r?\n/g, '\n').replace(/^\s*(?:&#x20;\s*)+/i, '');
    visitPromptTag(parsed, original, null, output);
  }
  return output;
}

function artistCardTag(card) {
  const title = String(card?.title ?? '').normalize('NFKC').trim();
  if (title) return title.replace(/^artist\s*:\s*/i, '').trim();
  return String(card?.prompt ?? '').normalize('NFKC').trim().replace(/^artist\s*:\s*/i, '').trim();
}

function artistChainCardTag(card) {
  const explicit = extractPromptTags(card?.prompt).filter((item) => item.explicit);
  if (explicit.length === 1) {
    const fromPrompt = normalizeArtistChainTag(explicit[0].name, { escapeCommas: true });
    if (!fromPrompt.error) return fromPrompt.tag;
  }
  const fromTitle = normalizeArtistChainTag(card?.title, { escapeCommas: true });
  return fromTitle.error ? '' : fromTitle.tag;
}

function promptArtistCatalog(koreanResults = [], { loading = false, importedResults = [] } = {}) {
  const records = [];
  const identities = new Set();
  const addCards = (cards, kind) => {
    for (const card of Array.isArray(cards) ? cards : []) {
      if (card?.section !== 'artist') continue;
      const name = artistCardTag(card);
      const key = artistTagKey(name);
      if (!key) continue;
      const recordId = [kind, card.id, card.title, card.source, card.model].join('\u0000');
      if (identities.has(recordId)) continue;
      identities.add(recordId);
      const keys = [key];
      let identity = key;
      const explicitName = /^artist\s*:\s*([\s\S]+)$/i.exec(card.prompt || '')?.[1];
      if (explicitName && explicitName !== name) {
        const tags = extractPromptTags(card.prompt);
        const tag = tags[0];
        if (tags.length === 1 && tag.explicit && tag.key && tag.key !== key) {
          keys.push(tag.key);
          identity = tag.key;
        }
      }
      records.push({ card, keys, kind, identity });
    }
  };
  if (loading) addCards(state.korean, 'korean');
  for (const result of koreanResults) {
    if (result.status === 'fulfilled') addCards(result.value, 'korean');
  }
  addCards(state.packRows, 'imported');
  for (const result of importedResults) {
    if (result.status === 'fulfilled') addCards(result.value, 'imported');
  }
  addCards(state.online, 'nax');
  const index = new Map();
  for (const record of records) {
    for (const key of record.keys) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
  }
  const failures = koreanResults
    .map((result, index) => result.status === 'rejected' ? koreanPacks[index]?.[1] : '')
    .filter(Boolean);
  return {
    index,
    records,
    loading,
    koreanReady: koreanResults.filter((result) => result.status === 'fulfilled').length,
    koreanFailures: failures,
    naxCount: records.filter((record) => record.kind === 'nax').length,
    importedCount: records.filter((record) => record.kind === 'imported').length,
    importedFailures: importedResults.filter((result) => result.status === 'rejected').length,
  };
}

function characterPromptCaption(entry) {
  return typeof entry === 'string' ? entry : entry?.char_caption || '';
}

function promptArtistSources(generation) {
  const positive = [];
  const negative = [];
  if (generation.prompt) positive.push({ label: '主提示词 · 正向', prompt: generation.prompt });
  if (generation.negativePrompt) negative.push({ label: '主提示词 · 负向', prompt: generation.negativePrompt });
  const characters = Array.isArray(generation.characters) ? generation.characters : [];
  const negativeCharacters = Array.isArray(generation.negativeCharacters) ? generation.negativeCharacters : [];
  for (let index = 0; index < Math.max(characters.length, negativeCharacters.length); index++) {
    const prompt = characterPromptCaption(characters[index]);
    const negativePrompt = characterPromptCaption(negativeCharacters[index]);
    if (prompt) positive.push({ label: `角色 ${index + 1} · 正向`, prompt });
    if (negativePrompt) negative.push({ label: `角色 ${index + 1} · 负向`, prompt: negativePrompt });
  }
  return { positive, negative };
}

function collectPromptArtists(generation, catalog, negative = false) {
  const output = new Map();
  const sources = promptArtistSources(generation)[negative ? 'negative' : 'positive'];
  for (const source of sources) {
    for (const tag of extractPromptTags(source.prompt)) {
      let key = tag.key;
      let name = tag.name;
      let candidates = catalog.index.get(key) || [];
      if (tag.repairColon && !candidates.length) {
        const colonlessName = name.slice(0, -1).trimEnd();
        const colonlessKey = artistTagKey(colonlessName);
        const colonlessCandidates = catalog.index.get(colonlessKey) || [];
        if (colonlessKey && colonlessCandidates.length) {
          key = colonlessKey;
          name = colonlessName;
          candidates = colonlessCandidates;
        }
      }
      if (!tag.explicit && !candidates.length) {
        const alternate = /^artist_(.+)$/i.exec(tag.name)?.[1];
        const alternateKey = alternate ? artistTagKey(alternate) : '';
        if (alternateKey && catalog.index.has(alternateKey)) {
          key = alternateKey;
          candidates = catalog.index.get(key);
        }
      }
      if (!tag.explicit && !candidates.length) continue;
      const identities = new Set(candidates.map(({ identity }) => identity));
      const ambiguous = identities.size > 1;
      if (!output.has(key)) {
        output.set(key, {
          key, name, explicit: tag.explicit,
          candidates: ambiguous ? [] : candidates, ambiguous, sources: new Set(), originals: new Set(),
        });
      }
      const item = output.get(key);
      item.explicit ||= tag.explicit;
      item.sources.add(source.label);
      item.originals.add(tag.original);
    }
  }
  return output;
}

function artistModelSeries(value) {
  const text = String(value ?? '');
  if (/V5/i.test(text)) return 'V5';
  if (/V4\.5/i.test(text)) return 'V4.5';
  return '';
}

function preferredArtistRecord(candidates, targetModel) {
  const kindRank = { imported: 3, korean: 2, nax: 1 };
  return [...candidates].map((record, index) => {
    const series = artistModelSeries(record.card.model);
    return {
      record, index,
      score: (targetModel && series === targetModel ? 1000 : 0)
        + (record.card.photos?.length ? 100 : 0)
        + (kindRank[record.kind] || 0),
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index)[0]?.record;
}

function promptArtistCatalogNote(catalog) {
  const parts = [];
  if (catalog.loading) parts.push('韩国目录读取中');
  else {
    const failure = catalog.koreanFailures.length ? `（${catalog.koreanFailures.join('、')}失败）` : '';
    parts.push(`韩国 ${catalog.koreanReady}/${koreanPacks.length}${failure}`);
  }
  if (Array.isArray(state.online)) parts.push(`NAX ${catalog.naxCount} 位`);
  else if (state.onlineTask) parts.push('NAX 读取中');
  else parts.push('NAX 未加载');
  if (Array.isArray(state.packRows)) {
    const failures = catalog.importedFailures ? `（${catalog.importedFailures} 个目录未能读取）` : '';
    parts.push(`导入 ${catalog.importedCount} 位${failures}`);
  }
  else if (state.importing) parts.push('导入目录读取中');
  else parts.push('导入目录未加载');
  return parts.join(' · ');
}

let promptArtistPanelSequence = 0;

function promptArtistRow(item, catalog, targetModel, openSample, polarity, sampleState) {
  const row = node('div', 'prompt-artist-row');
  const header = node('div', 'pack-source');
  const info = node('div');
  info.append(node('strong', '', item.name));
  if (item.candidates.length) {
    const librarySources = [...new Set(item.candidates.map((record) =>
      record.card.source || (record.kind === 'nax' ? 'NAX' : record.kind === 'imported' ? '已导入' : '韩国 V5')))];
    info.append(node('small', '', `库内同名 · ${librarySources.join('；')}`));
  } else if (item.ambiguous) {
    info.append(node('small', '', '同名对应多个完整标签，可在画风串里搜索确认。'));
  } else {
    info.append(node('small', '', '显式 artist: · 已保留，当前目录未精确命中'));
  }
  info.append(node('small', '', `来源：${[...item.sources].join('、')} · 原值：${[...item.originals].join(' / ')}`));
  const controls = node('div', 'copy-fact');
  controls.append(button('复制原标签', 'text-button', () => copy([...item.originals].join('\n'))));
  const preferred = preferredArtistRecord(item.candidates, targetModel);
  if (preferred) {
    const sampleModel = preferred.card.model || '未标注';
    const targetSeries = artistModelSeries(targetModel);
    const sampleSeries = artistModelSeries(sampleModel);
    info.append(node('small', '', `样图模型：${sampleModel}${targetSeries && sampleSeries && targetSeries !== sampleSeries ? `（当前 ${targetSeries}）` : ''}`));
    const photos = Array.isArray(preferred.card.photos) ? preferred.card.photos : [];
    if (photos.length) {
      const stateKey = `${polarity}:${item.key}`;
      const state = sampleState.get(stateKey) || { expanded: false, index: 0 };
      if (!Number.isSafeInteger(state.index) || state.index < 0 || state.index >= photos.length) state.index = 0;
      sampleState.set(stateKey, state);
      const panel = node('div', 'artist-sample-panel');
      panel.id = `artist-sample-${++promptArtistPanelSequence}`;
      panel.hidden = true;
      let loadRevision = 0;
      let toggle;

      function loadSample() {
        const photo = photos[state.index];
        const revision = ++loadRevision;
        panel.hidden = false;
        if (!photo?.url) {
          panel.replaceChildren(node('p', 'resource-note', '样图加载失败：当前条目没有可用的图片地址。'));
          return;
        }
        const frame = node('div', 'photo');
        const status = node('div', 'artist-sample-status', '正在读取样图…');
        status.setAttribute('role', 'status');
        const image = node('img');
        image.alt = `${item.name} · ${photo.label || `样图 ${state.index + 1}`}`;
        image.hidden = true;
        image.onload = () => {
          if (revision !== loadRevision || panel.hidden) return;
          image.hidden = false;
          status.remove();
        };
        image.onerror = () => {
          if (revision !== loadRevision || panel.hidden) return;
          image.hidden = true;
          status.replaceChildren(node('span', '', '样图加载失败。'),
            button('重试', 'text-button', loadSample));
        };
        const position = node('span', '', `${state.index + 1} / ${photos.length} · ${photo.label || '样图'}`);
        const previous = button('上一张', 'text-button', () => {
          state.index = (state.index + photos.length - 1) % photos.length;
          loadSample();
        });
        const next = button('下一张', 'text-button', () => {
          state.index = (state.index + 1) % photos.length;
          loadSample();
        });
        previous.disabled = next.disabled = photos.length < 2;
        const nav = node('div', 'photo-nav artist-sample-nav');
        nav.append(previous, position, next);
        frame.append(status, image);
        panel.replaceChildren(frame, nav);
        image.src = photo.url;
      }

      toggle = button(state.expanded ? '收起样图' : '看样图', 'soft compact', () => {
        state.expanded = !state.expanded;
        panel.hidden = !state.expanded;
        toggle.textContent = state.expanded ? '收起样图' : '看样图';
        toggle.setAttribute('aria-expanded', String(state.expanded));
        if (state.expanded) loadSample();
        else loadRevision++;
      });
      toggle.setAttribute('aria-expanded', String(state.expanded));
      toggle.setAttribute('aria-controls', panel.id);
      controls.append(toggle);
      if (state.expanded) loadSample();
      header.append(info, controls);
      row.append(header, panel);
      return row;
    }
    controls.append(button('看详情', 'soft compact', () => openSample(preferred.card)));
  }
  header.append(info, controls);
  row.append(header);
  return row;
}

function renderPromptArtistUsage(generation, catalog, openSample, sampleState, openArtistChain) {
  const section = node('section', 'tool-section');
  const title = node('h2', '', '画风库画师');
  const used = collectPromptArtists(generation, catalog);
  const negative = collectPromptArtists(generation, catalog, true);
  const targetModel = artistModelSeries(novelAiModelLabel(
    generation.parameters?.model || generation.parameters?.model_name || generation.model,
    generation.parameters?.model_hash));
  const matchedPositive = [...used.values()].filter((item) => item.candidates.length);
  title.append(node('span', 'muted', ` · 正向命中 ${matchedPositive.length} 位`));
  section.append(title,
    node('p', 'resource-note', `${promptArtistCatalogNote(catalog)}。仅按完整标签精确识别；无前缀必须与库内规范化名称完全一致，不扫描自然语言。`));
  if (matchedPositive.length && openArtistChain) {
    section.append(button(`把识别到的 ${matchedPositive.length} 位画师加入画风串`, 'soft compact', () => {
      openArtistChain(matchedPositive, targetModel);
    }));
  }
  if (!used.size) {
    section.append(node('p', 'detail-note', catalog.loading
      ? '显式 artist 已可识别；无前缀画师会在目录读取完成后按同名匹配。'
      : '没有识别到正向使用的库内画师。'));
  } else {
    for (const item of used.values()) {
      section.append(promptArtistRow(item, catalog, targetModel, openSample, 'positive', sampleState));
    }
  }
  if (negative.size) {
    const details = node('details', 'metadata-details');
    details.append(node('summary', '', `负向中出现 · ${negative.size} 位（不视为使用）`));
    for (const item of negative.values()) {
      details.append(promptArtistRow(item, catalog, targetModel, openSample, 'negative', sampleState));
    }
    section.append(details);
  }
  return section;
}

const promptCoverBytes = 192 * 1024;

function smallPromptPreview(value) {
  return typeof value === 'string' && value.length <= promptCoverBytes * 4 / 3 + 'data:image/jpeg;base64,'.length
    && /^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

async function promptFavoriteCover(preview, galleryItem, sampleImage) {
  if (smallPromptPreview(preview)) return preview;
  try {
    if (galleryItem) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(galleryImageUrl(galleryItem, true), { signal: controller.signal });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.size > promptCoverBytes || !['image/jpeg', 'image/webp'].includes(blob.type)) return null;
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(smallPromptPreview(reader.result) ? reader.result : null);
          reader.onerror = reader.onabort = () => resolve(null);
          try { reader.readAsDataURL(blob); } catch { resolve(null); }
        });
      } finally { clearTimeout(timeout); }
    }
    if (!sampleImage?.naturalWidth || !sampleImage.naturalHeight) return null;
    const scale = Math.min(1, 384 / Math.max(sampleImage.naturalWidth, sampleImage.naturalHeight));
    const canvas = node('canvas');
    canvas.width = Math.max(1, Math.round(sampleImage.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(sampleImage.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sampleImage, 0, 0, canvas.width, canvas.height);
    const cover = canvas.toDataURL('image/jpeg', .8);
    return smallPromptPreview(cover) ? cover : null;
  } catch {
    return null;
  }
}

function showPromptImport(data, {
  back = null, galleryItem = null, resourcePhoto = null, promptState = null, promptScroll = 0,
} = {}) {
  const sample = Boolean(resourcePhoto);
  openScreen(sample ? '样图提示词与参数' : '原图提示词与参数', back);
  const revision = screenRevision;
  const restored = promptState && typeof promptState === 'object' ? promptState : null;
  const restoredScroll = Number.isFinite(promptScroll) ? Math.max(0, promptScroll) : 0;
  const libraryButton = button('存小预览到图库', 'soft compact', async () => {
    libraryButton.disabled = true;
    try {
      const saved = await native('saveLastOriginal');
      if (revision !== screenRevision) return;
      if (!saved?.id) throw new Error('无法保存原图。');
      libraryButton.replaceWith(button('打开原图图库', 'soft compact', showGallery));
      toast(saved.promptCached ? '图库已保存图片预览和生成信息' : '图片预览已在图库');
    } catch (error) {
      if (revision !== screenRevision) return;
      libraryButton.disabled = false;
      toast(error.message);
    }
  });
  let fallbackPreview = null;
  if (!resourcePhoto?.preview && smallPromptPreview(data.preview)) {
    fallbackPreview = node('img', 'original-preview');
    fallbackPreview.src = data.preview;
    fallbackPreview.alt = '所选原图预览';
  } else if (!resourcePhoto?.preview && galleryItem) {
    fallbackPreview = node('img', 'original-preview');
    fallbackPreview.src = galleryImageUrl(galleryItem, true);
    fallbackPreview.alt = '图库小预览';
    fallbackPreview.addEventListener('error', () => {
      fallbackPreview.remove();
      layout.classList.remove('has-preview');
      if (revision === screenRevision) screen.classList.remove('detail-wide');
    });
  }
  const hasPreview = Boolean(resourcePhoto?.preview || fallbackPreview);
  if (hasPreview) screen.classList.add('detail-wide');
  const layout = node('div', `prompt-import-layout${hasPreview ? ' has-preview' : ''}`);
  const media = node('div', 'prompt-import-media');
  const info = node('div', 'prompt-import-info');
  layout.append(media, info);
  body.append(layout);
  if (!galleryItem && !sample) info.append(libraryButton);
  if (sample) {
    const source = resourcePhoto;
    if (source.preview) {
      source.preview.className = 'original-preview';
      media.append(source.preview);
    }
    const facts = ['样图', source.title, source.label, source.source].filter(Boolean);
    info.append(node('p', 'resource-note', facts.join(' · ')));
  }
  if (galleryItem) {
    info.append(node('p', 'resource-note', data.promptCached
      ? '生成信息已在本机保存。'
      : '此次结果未能存入图库。可使用「收藏所选」长期保留需要的内容。'));
  }
  if (fallbackPreview) media.append(fallbackPreview);
  const availablePrompt = data.found || data.actualPrompt || data.actualNegativePrompt
    || data.actualCharacters?.length || data.actualNegativeCharacters?.length;
  if (!availablePrompt) info.append(node('p', 'detail-note', data.message || '未读到提示词。截图和转存可能清除生成信息。'));
  info.append(node('p', 'resource-note', `${data.metadataType || '图片元数据'} · 可逐项复制，勾选控制「复制所选」。`));
  const selection = node('div', 'prompt-selection');
  const content = node('div');
  const artistMatches = node('div');
  content.append(artistMatches);
  const selected = {};
  const artistSampleState = new Map();
  let preparingFavorite = false;
  const hasActual = Boolean(data.actualPrompt || data.actualNegativePrompt
    || data.actualCharacters?.length || data.actualNegativeCharacters?.length);
  selected.actual = hasActual && Boolean(restored?.actual);
  const groups = [
    ['positive', '正向提示词', Boolean(data.prompt || data.actualPrompt)],
    ['negative', '负向提示词', Boolean(data.negativePrompt || data.actualNegativePrompt)],
    ['characters', '角色提示词和位置', Boolean(data.characters?.length || data.negativeCharacters?.length || data.actualCharacters?.length || data.actualNegativeCharacters?.length)],
    ['settings', '模型与生成设置', Boolean(data.parameters || data.model)],
    ['seed', '种子', data.parameters?.seed !== undefined],
  ];
  for (const [key, label, available] of groups) {
    const checked = available && (restored ? Boolean(restored[key]) : true);
    selected[key] = checked;
    if (available) selection.append(checkOption(label, checked, (next) => { selected[key] = next; renderFields(); }));
  }
  if (hasActual) {
    selection.append(checkOption('使用随机展开后的实际提示词', selected.actual, (checked) => {
      selected.actual = checked;
      renderFields();
    }));
  }
  if (selection.childElementCount) info.append(selection);
  info.append(content);
  let koreanResults = [];
  let importedResults = [];
  let koreanLoading = true;
  let artistCatalog = promptArtistCatalog(koreanResults, { loading: koreanLoading });
  function refreshArtistMatches() {
    if (revision !== screenRevision) return;
    const scroll = body.scrollTop;
    artistCatalog = promptArtistCatalog(koreanResults, { loading: koreanLoading, importedResults });
    renderArtistMatches();
    body.scrollTop = scroll;
  }
  Promise.allSettled(koreanPacks.map(([id]) => loadKoreanCatalog(id))).then((results) => {
    koreanResults = results;
    koreanLoading = false;
    refreshArtistMatches();
  });
  loadSavedNaxDirectory(revision)?.then(() => {
    if (state.online) refreshArtistMatches();
  }).catch(() => { /* The bundled and imported catalogs remain available. */ });
  loadImportedArtistCatalogs().then((results) => {
    importedResults = results;
    if (results.length) refreshArtistMatches();
  });
  const rawFields = Object.entries(data.metadata || {});
  if (rawFields.length || data.rawComment) {
    const disclosure = node('section', 'metadata-disclosure');
    const details = node('details', 'metadata-details raw-metadata');
    details.append(node('summary', '', '原始元数据'));
    const raw = node('dl', 'metadata-facts');
    for (const [key, value] of rawFields) appendCopyFact(raw, key, value, '空值', true);
    if (raw.childElementCount) details.append(raw);
    disclosure.append(details, button('复制原始数据', 'soft compact metadata-disclosure-copy',
      () => copy(rawFields.length ? data.metadata : data.rawComment)));
    info.append(disclosure);
  }

  function showArtistSample(card) {
    const scroll = body.scrollTop;
    const stateForReturn = { ...selected };
    showCard(card, 0, () => showPromptImport(data, {
      back, galleryItem, resourcePhoto,
      promptState: stateForReturn,
      promptScroll: scroll,
    }));
  }

  function addRecognizedArtists(items, targetModel) {
    const scroll = body.scrollTop;
    const stateForReturn = { ...selected };
    const cards = items.map((item) => preferredArtistRecord(item.candidates, targetModel)?.card)
      .filter(Boolean);
    if (!cards.length) {
      toast('没有可加入的库内正向画师。');
      return;
    }
    openArtistChainWorkbench({
      defaultModel: targetModel || null,
      initialArtists: cards,
      back: () => showPromptImport(data, {
        back, galleryItem, resourcePhoto,
        promptState: stateForReturn,
        promptScroll: scroll,
      }),
    });
  }

  function renderArtistMatches() {
    const recognized = selectedGeneration(data, {
      positive: true, negative: true, characters: true, settings: true, actual: selected.actual,
    });
    artistMatches.replaceChildren(renderPromptArtistUsage(
      recognized, artistCatalog, showArtistSample, artistSampleState, addRecognizedArtists));
  }

  function renderFields() {
    const scroll = body.scrollTop;
    const generation = selectedGeneration(data, selected);
    content.replaceChildren(artistMatches);
    renderArtistMatches();
    addCopyablePrompt(content, '正向提示词', generation.prompt);
    addCopyablePrompt(content, '负向提示词', generation.negativePrompt);
    renderCharacterPrompts(content, generation.characters, generation.negativeCharacters);
    const params = selectedGeneration(data, { settings: true, seed: true }).parameters;
    if (data.model && params.model == null) params.model = data.model;
    const settings = node('section', 'tool-section');
    const parameterHeading = node('div', 'online-pack-heading');
    parameterHeading.append(node('h2', '', '生成参数'));
    if (Object.keys(params).length) parameterHeading.append(button('复制全部生成参数', 'soft compact', () => copy(params)));
    settings.append(parameterHeading);
    const facts = node('dl', 'metadata-facts');
    const model = novelAiModelLabel(params.model || params.model_name, params.model_hash);
    appendCopyFact(facts, '模型', model);
    for (const key of new Set(['sampler', 'steps', ...Object.keys(parameterLabels), ...Object.keys(params)])) {
      if (key === 'model' && params.model === model) continue;
      const label = key === 'model' ? '原始模型标识' :
        Object.prototype.hasOwnProperty.call(parameterLabels, key) ? parameterLabels[key] : key;
      appendCopyFact(facts, label,
        Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined,
        ['sampler', 'steps'].includes(key) ? '原图未记录' : undefined, true);
    }
    settings.append(facts);
    content.append(settings);
    const json = JSON.stringify(generation, null, 2);
    const chosen = groups.some(([key]) => selected[key]);
    actions.replaceChildren(button(galleryItem ? '返回原图' : sample ? '返回样图' : '另选原图', 'soft',
      back || (sample ? closeScreen : readImagePrompts)));
    const copySelection = button('复制所选', 'soft', () => copy(json));
    const save = button(preparingFavorite ? '正在准备封面…' : '收藏所选', 'primary', async () => {
      if (preparingFavorite) return;
      if (new Blob([json]).size > 2 * 1024 * 1024 || generation.prompt.length > 16000) { toast('所选信息超过收藏上限，请保留原图。'); return; }
      const note = generation.negativePrompt && generation.negativePrompt.length < 7900
        ? '负向提示词：\n' + generation.negativePrompt : '已附带所选生成信息。';
      const source = resourcePhoto || {};
      preparingFavorite = true;
      save.disabled = true;
      save.textContent = '正在准备封面…';
      const cover = await promptFavoriteCover(data.preview, galleryItem, source.preview);
      if (revision !== screenRevision) return;
      showEditor({ section: 'knowledge', kind: 'general', title: sample ? '样图生成信息' : '原图生成信息',
        prompt: generation.prompt, note, photos: cover ? [{ url: cover, label: '图片预览' }] : [], generation: json,
        source: source.source, sourceUrl: source.sourceUrl });
      if (!cover) toast('小预览暂不可用，可在编辑页选择配图。');
    });
    copySelection.disabled = !chosen;
    save.disabled = !chosen || preparingFavorite;
    actions.append(copySelection, save);
    body.scrollTop = scroll;
  }
  renderFields();
  if (restoredScroll) {
    body.scrollTop = restoredScroll;
    requestAnimationFrame(() => {
      if (revision === screenRevision) body.scrollTop = restoredScroll;
    });
  }
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

function showTools(initialUpdate) {
  openScreen('设置与工具');
  const image = toolSection('导入原图生成信息', '选择 NovelAI 保存的 PNG 或 WebP 原图，逐项复制提示词和生成参数。也可保存小预览和生成信息到图库。');
  image.append(button('选择原图', 'primary', readImagePrompts));
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
  const update = toolSection('应用版本更新', '打开 App 时自动检查并下载新版。下载后校验长度、签名和版本，由你在安卓系统中确认安装。');
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
    version.textContent = '当前为浏览器预览，安卓 App 中可检查版本。';
    saveRepo.disabled = check.disabled = true;
  }
  const thanks = toolSection('来源与感谢', '感谢韩国 Arca Live 社区作者 bequiet / baqu2213 分享原版画师库和查看器；感谢 Carlyone 的 NAX 图库，以及韩国社区和 NovelAI 官方资料。');
  thanks.append(button('原版画师资源', 'text-button', () => openLink('https://arca.live/b/aiart/185691299')),
    button('NAX · CC BY 4.0', 'text-button', () => openLink(PocketSources.nax)));
  if (initialUpdate?.available || updateOffer?.available) {
    displayUpdate(initialUpdate?.available ? initialUpdate : updateOffer);
    if (initialUpdate?.available) update.scrollIntoView({ block: 'start' });
  }
}

byId('tools').addEventListener('click', showTools);
byId('gallery').addEventListener('click', () => showGallery());
byId('add').addEventListener('click', () => showEditor());
byId('close').addEventListener('click', goBack);
byId('personal').addEventListener('click', () => chooseMode('personal'));
byId('online').addEventListener('click', () => chooseMode('online'));
byId('nav').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-section]');
  if (tab) chooseSection(tab.dataset.section);
});
let queryTimer;
query.addEventListener('input', () => {
  resetPage();
  clearTimeout(queryTimer);
  queryTimer = setTimeout(renderList, 80);
});
screen.addEventListener('cancel', (event) => { event.preventDefault(); goBack(); });
window.PocketBack = () => {
  if (screen.open) { goBack(); return true; }
  if (state.galleryFocus) { setGalleryLayout(false); render(); return true; }
  if (state.mode === 'online') { chooseMode('personal'); return true; }
  return false;
};
window.PocketForeground = checkAutomaticUpdate;

ensureKorean();
render();
loadGalleryPacks();
loadPersonal();
loadPacks();
checkForSavedDirectory();
checkAutomaticUpdate();
