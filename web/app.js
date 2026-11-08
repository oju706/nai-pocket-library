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
const state = {
  section: 'artist', mode: 'online', model: 'V5', kind: 'all', knowledgeTab: 'basic', artistSource: 'korean',
  page: 0, online: null, onlineTask: null, onlineError: false, hasOnline: false,
  personal: [], personalError: false, packs: [], pack: null, packRows: [],
  packMessage: '', importing: false, importingRemote: false,
  artistGroup: 'all', galleryFocus: false, galleryColumns: 3, artistShuffle: 0, artistOrder: 'name',
  artistPostBand: 'all', koreanPostBands: [],
  characterFilters: {},
  koreanPack: 'all', korean: null, koreanTask: null, koreanError: false, koreanChecking: false, koreanStatus: '',
};
const koreanPacks = [['curated', 'Curated 精选'], ['33000', '33000-Q'], ['55000', '55000-Q']];
const koreanCatalogs = new Map();
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
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[_\s]+/g, ' ').trim();
}

function groupingName(title) {
  return String(title ?? '').normalize('NFKC').trim().replace(/^artist:\s*/i, '');
}

function foldInitial(character) {
  return character.normalize('NFD').replace(/\p{Mark}/gu, '').toUpperCase();
}

function artistGroup(title) {
  const [first = ''] = groupingName(title);
  const latin = foldInitial(first);
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
    const name = groupingName(card.title);
    const [first = ''] = name;
    if (foldInitial(first) !== pair[1]) return false;
    const [second = ''] = name.slice(first.length).trimStart();
    return foldInitial(second) === pair[2];
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

function ensureKorean() {
  if (state.korean || state.koreanTask?.pack === state.koreanPack) return;
  const task = { pack: state.koreanPack };
  const packs = task.pack === 'all' ? koreanPacks.map(([id]) => id) : [task.pack];
  state.koreanError = false;
  state.koreanTask = task;
  Promise.all(packs.map((id) => {
    if (!koreanCatalogs.has(id)) {
      koreanCatalogs.set(id, getJson(`/api/korean.json?pack=${id}`).then(PocketSources.koreanCards).catch((error) => {
        koreanCatalogs.delete(id);
        throw error;
      }));
    }
    return koreanCatalogs.get(id);
  })).then((catalogs) => {
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

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('读取失败');
  return response.json();
}

function ensureOnline(check = false) {
  if (state.onlineTask || (state.online && !check)) return;
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

async function loadPacks() {
  if (!window.Pocket) return;
  try {
    state.packs = await native('listPacks');
    render();
  } catch {
    toast('读取已有数据包失败。');
  }
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
  openScreen('更多画师图包');
  if (window.Pocket) {
    const online = toolSection('在线浏览图包', '内置社区画风图包打开即用，也可以填写自己的 GitHub 资源仓库。');
    online.append(button('打开在线社区画风', 'primary', () => showRemoteSharedStylePack(showPackSources)),
      button('自定义 GitHub 仓库', 'soft', () => showOnlinePack(showPackSources)));
    const shared = toolSection('韩国社区画风 ZIP', '直接读取手机里 NAImakeArtistGroup 的社区画风合集或画风测试包。');
    shared.append(button('打开社区画风图包', 'primary', () => showSharedStylePack(showPackSources)));
  }
  const sources = toolSection('从原作者下载', '在浏览器保存所选图包，再回到这里导入。作者的全量包较大，请按需要选择。');
  const originalRoot = 'https://huggingface.co/baqu2213/PoemForSmallFThings/blob/main/NAIA/';
  for (const [title, info, path] of [
    ['V5 Curated 精选', '约 1.03 GB · 已有在线目录', 'NAID5_artist_thumbnail/NAID5-33000-55000-Curated'],
    ['V5 33000-Q', '约 4.62 GB', 'NAID5_artist_thumbnail/NAID5F-33000-Q'],
    ['V5 55000-Q', '约 3.19 GB', 'NAID5_artist_thumbnail/NAID5F-55000-Q'],
    ['V4.5 31000 版', '约 2.73 GB', 'NAID4.5_artist_thumbnail_31000/artist_thumbnail_nai'],
  ]) {
    const row = node('div', 'pack-source');
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
  const korean = isKorean();
  tools.hidden = false;
  tools.setAttribute('aria-label', korean ? '名称与作品数筛选' : '按名称开头分类');
  document.querySelector('.shell').classList.toggle('gallery-focus', state.galleryFocus);
  tools.replaceChildren();
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
  const pair = /^letter-([A-Z])([A-Z0-9])$/.exec(state.artistGroup);
  groups.value = pair ? `letter-${pair[1]}` : state.artistGroup;
  const changeGroup = (value) => {
    state.artistGroup = value;
    state.artistShuffle = 0;
    resetPage();
    render();
  };
  groups.addEventListener('change', () => {
    changeGroup(groups.value);
  });
  const toolbar = node('div', 'discovery-controls');
  toolbar.append(groups);
  const firstLetter = /^letter-([A-Z])$/.exec(groups.value);
  if (firstLetter) {
    const letter = firstLetter[1];
    const prefixes = node('select', 'artist-group artist-prefix');
    prefixes.setAttribute('aria-label', `按名称开头前两位筛选（${letter}）`);
    addOptions(prefixes, [[`letter-${letter}`, `${letter} 全部`],
      ...Array.from(initialLetters + initialDigits, (key) => [`letter-${letter}${key}`, `${letter}${key}`])]);
    prefixes.value = pair ? `letter-${pair[1]}${pair[2]}` : `letter-${letter}`;
    prefixes.addEventListener('change', () => changeGroup(prefixes.value));
    toolbar.append(prefixes);
  }
  if (state.section === 'artist') {
    toolbar.append(button('换一批', 'soft compact', () => {
      state.artistShuffle = (Math.random() * 0xffffffff >>> 0) || 1;
      resetPage();
      render();
    }), button(state.galleryFocus ? '退出图墙' : '全屏图墙', 'soft compact', () => {
      setGalleryLayout(!state.galleryFocus);
      render();
    }));
  }
  tools.append(toolbar);
  if (state.galleryFocus || state.artistShuffle || korean) {
    const controls = node('div', 'discovery-controls');
    if (state.galleryFocus) {
      for (const columns of [2, 3, 4]) {
        controls.append(chip(`${columns} 列`, state.galleryColumns === columns, () => {
          if (state.galleryColumns === columns) return;
          setGalleryLayout(true, columns);
          render();
        }));
      }
    }
    if (korean) {
      const bands = state.korean ? state.koreanPostBands : [];
      const postCounts = options([['all', '作品数分档 · 全部'],
        ...bands.map(band => [band, band === 'unknown' ? '作品数分档 · 未统计'
          : `作品数分档 · ${number.format(band)}–${number.format(Number(band) + 99)}`])], state.korean ? state.artistPostBand : 'all');
      postCounts.className = 'artist-group';
      postCounts.disabled = !state.korean;
      postCounts.setAttribute('aria-label', '作品数分档');
      postCounts.setAttribute('aria-describedby', 'artist-post-band-note');
      postCounts.addEventListener('change', () => {
        state.artistPostBand = postCounts.value;
        resetPage();
        render();
      });
      controls.append(postCounts, chip('按作品数', state.artistOrder === 'posts' && !state.artistShuffle, () => {
        state.artistOrder = state.artistOrder === 'posts' && !state.artistShuffle ? 'name' : 'posts';
        state.artistShuffle = 0;
        resetPage();
        render();
      }));
    }
    if (state.artistShuffle) controls.append(button('恢复排序', 'text-button', () => {
      state.artistShuffle = 0;
      resetPage();
      render();
    }));
    tools.append(controls);
  }
  if (korean) {
    const note = node('p', 'resource-note', '原库作品数供热度参考，可和名称分类、搜索一起筛选。');
    note.id = 'artist-post-band-note';
    tools.append(note);
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
    const sources = [['korean', '韩国主库'], ['nax', 'NAX 补充']];
    if (state.packs.length) sources.push(['imported', '已导入']);
    for (const [id, label] of sources) resourceTabs.append(chip(label, state.artistSource === id, () => {
      state.artistSource = id;
      state.model = id === 'imported' ? 'pack' : 'V5';
      state.artistShuffle = 0;
      resetPage();
      if (id === 'imported') selectPack(state.pack?.id || state.packs[0]?.id);
      else if (id === 'korean') ensureKorean();
      else if (state.hasOnline) ensureOnline();
      render();
    }));
    if (window.Pocket) resourceTabs.append(button('在线图包', 'text-button', () => showRemoteSharedStylePack()),
      button('自定义图包', 'text-button', () => showOnlinePack()));
    resourceTabs.append(button('更多图包', 'text-button', showPackSources));
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
  const viewOptions = byId('view-options');
  viewOptions.replaceChildren(node('span', '', '显示'));
  for (const [value, label] of [['grid', '双列看图'], ['list', '图文列表'], ['compact', '紧凑文字']]) {
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

function thumbnail(card, grid) {
  const box = node('span', grid ? 'card-photo' : 'row-photo');
  const placeholder = node('span', 'preview-placeholder');
  placeholder.append(icon(sections[card.section].icon));
  const caption = node('span', '', card.photos.length ? '加载预览' : '暂无配图');
  placeholder.append(caption);
  box.append(placeholder);
  if (card.photos.length) {
    const img = node('img', 'preview-image');
    img.alt = card.title + ' 样图';
    img.decoding = 'async';
    img.dataset.src = card.photos[0].url;
    img.onload = () => { placeholder.remove(); img.classList.add('loaded'); };
    img.onerror = () => { caption.textContent = '预览暂不可用'; img.remove(); };
    box.append(img);
    previews.observe(img);
  }
  return box;
}

function row(card) {
  const view = state.galleryFocus ? 'grid' : views[state.section];
  const grid = view === 'grid';
  const item = node('article', grid ? 'card' : 'row');
  const hit = button(card.title, grid ? 'card-main' : 'row-main', () => showCard(card));
  hit.setAttribute('aria-label', card.title);
  const mark = node('span', 'row-mark');
  mark.append(icon(sections[card.section].icon));
  const text = node('span', 'row-text');
  const caption = card.section === 'knowledge'
    ? [knowledgeKinds.find(([key]) => key === card.kind)?.[1] || '通用写法', card.prompt || card.source]
    : [card.work, card.outfit, card.model, card.source || (card.photos.length ? '有配图' : '自建')];
  if (Number.isSafeInteger(card.postCount)) caption.push(`原库 ${number.format(card.postCount)} 条`);
  text.append(node('span', 'row-title', card.title), node('span', 'row-caption', caption.filter(Boolean).join(' · ')));
  if (card.section === 'knowledge' && card.note && view !== 'compact') text.append(node('span', 'row-note', card.note));
  hit.replaceChildren(view === 'compact' || (view === 'list' && !card.photos.length) ? mark : thumbnail(card, grid), text);
  item.append(hit);
  if (!state.galleryFocus) {
    if (card.prompt) item.append(button(`复制 ${card.title}`, 'icon-button', () => copy(card.prompt), 'copy'));
    else item.append(button(`查看 ${card.title}`, 'icon-button', () => showCard(card), 'arrow'));
  }
  return item;
}

function renderList() {
  previews.disconnect();
  const meta = byId('list-meta');
  meta.replaceChildren();
  results.replaceChildren();
  const personal = state.mode === 'personal';
  const knowledge = state.section === 'knowledge';
  const korean = isKorean();
  const pack = !personal && state.section === 'artist' && state.artistSource === 'imported';
  const remote = isRemote();
  if (korean) {
    const label = state.koreanPack === 'all' ? '精选、33000-Q 和 55000-Q' : koreanPacks.find(([id]) => id === state.koreanPack)?.[1];
    results.append(node('p', 'resource-note', state.koreanStatus || `韩国原版 V5 · ${label} · ${state.korean ? `${number.format(state.korean.length)} 位画师 · ` : ''}样图按需加载。`));
    const check = button(state.koreanChecking ? '检查中…' : '检查韩国原库更新', 'text-button', checkKorean);
    check.disabled = state.koreanChecking;
    meta.append(check);
    if (!state.korean) {
      empty(state.koreanError ? '主库目录读取失败' : '正在打开韩国主库', '可以在上方切换单个图包。', ...(state.koreanError ? [button('重试', 'soft', () => { ensureKorean(); renderList(); })] : []));
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
    meta.append(importer);
  }
  if (remote && state.online) {
    const label = state.section === 'knowledge' ? '检查知识图鉴更新' : state.section === 'artist' ? '检查画师资源更新' : '检查角色资源更新';
    const update = button(state.onlineTask ? '检查中…' : label, 'text-button', () => ensureOnline(true));
    update.disabled = Boolean(state.onlineTask);
    meta.append(update);
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
  const terms = searchText(query.value).split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
  const matching = source.filter((card) => {
    if (card.section !== state.section || (remote && card.model !== state.model)) return false;
    if (knowledge && state.kind !== 'all' && card.kind !== state.kind) return false;
    if (!matchesArtistGroup(card, state.artistGroup)) return false;
    if (!matchesPostCountBand(card, postBand)) return false;
    if (state.section === 'character' && !characterFields.every(([key]) => {
      const filter = state.characterFilters[key];
      return !filter || (filter === ' ' ? !card[key] : card[key] === filter);
    })) return false;
    if (!terms.length) return true;
    const words = searchText([card.title, card.prompt, card.note, card.work, card.outfit, card.gender, card.species].join(' '));
    return terms.every((term) => words.includes(term));
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
  if (pages > 1) results.append(pageJump(state.page, pages, move));
  const list = node('div', state.galleryFocus ? `gallery gallery-${state.galleryColumns} dense-gallery`
    : views[state.section] === 'grid' ? 'gallery' : 'list');
  list.append(...matching.slice(start, start + capacity).map(row));
  results.append(list);
  if (pages > 1) results.append(pageSteps(state.page, pages, move));
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

function openScreen(title, back = null) {
  screenRevision++;
  screenBack = back;
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

function showPhotos(card, initialIndex = 0) {
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
            back: () => showCard(card, photoIndex),
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

function showCard(card, photoIndex = 0) {
  openScreen('条目详情');
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
  showPhotos(card, photoIndex);
  if (card.prompt) body.append(node('div', 'prompt', card.prompt));
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
  if (card.local) {
    actions.append(button('编辑', 'soft', () => showEditor(card)));
    if (card.section === 'character') actions.append(button('另存服装', 'soft', () => showEditor({ ...card, id: card.from || card.id, local: false, outfit: '' })));
  }
  else actions.append(button('加入我的', card.prompt ? 'soft' : 'primary', () => {
    const existing = state.personal.find((saved) => saved.from === card.id || (card.section !== 'knowledge' && cardIdentity(saved) === cardIdentity(card)));
    if (existing) {
      const photos = [...existing.photos];
      for (const photo of card.photos) if (!photos.some((item) => item.url === photo.url)) photos.push({ ...photo, label: `${card.license ? 'Carlyone / NAX · CC BY 4.0' : card.source || ''} · ${photo.label || '样图'}` });
      showEditor({ ...existing, photos });
      toast('已有同标签收藏，保留原内容并补充来源样图');
    } else showEditor(card);
  }));
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
    const group = node('section', 'tool-section character-prompts');
    const fields = { prompt: caption(positive), negativePrompt: caption(negative) };
    if (positive?.centers?.length) fields.centers = positive.centers;
    if (negative?.centers?.length) fields.negativeCenters = negative.centers;
    group.append(node('h2', '', title),
      button('复制这位角色', 'soft compact', () => copy(fields)));
    addCopyablePrompt(group, title + '正向', fields.prompt);
    addCopyablePrompt(group, title + '负向', fields.negativePrompt);
    const positions = node('dl', 'metadata-facts');
    appendCopyFact(positions, '正向位置', fields.centers);
    appendCopyFact(positions, '负向位置', fields.negativeCenters);
    if (positions.childElementCount) group.append(positions);
    container.append(group);
  }
}

function addCopyablePrompt(container, label, value) {
  if (!value) return;
  const section = node('div', 'copyable-prompt');
  const control = button('复制' + label, 'soft compact', () => copy(value));
  section.append(node('h3', '', label), node('div', 'prompt', value), control);
  container.append(section);
}

function showPromptImport(data, { back = null, galleryItem = null, resourcePhoto = null } = {}) {
  const sample = Boolean(resourcePhoto);
  openScreen(sample ? '样图提示词与参数' : '原图提示词与参数', back);
  const revision = screenRevision;
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
  if (!galleryItem && !sample) body.append(libraryButton);
  if (sample) {
    const source = resourcePhoto;
    if (source.preview) {
      source.preview.className = 'original-preview';
      body.append(source.preview);
    }
    const facts = ['样图', source.title, source.label, source.source].filter(Boolean);
    body.append(node('p', 'resource-note', facts.join(' · ')));
  }
  if (galleryItem) {
    body.append(node('p', 'resource-note', data.promptCached
      ? '生成信息已在本机保存。'
      : '此次结果未能存入图库。可使用「收藏所选」长期保留需要的内容。'));
  }
  if (data.preview && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.preview)) {
    const preview = node('img', 'original-preview');
    preview.src = data.preview;
    preview.alt = '所选原图预览';
    body.append(preview);
  }
  const availablePrompt = data.found || data.actualPrompt || data.actualNegativePrompt
    || data.actualCharacters?.length || data.actualNegativeCharacters?.length;
  if (!availablePrompt) body.append(node('p', 'detail-note', data.message || '未读到提示词。截图和转存可能清除生成信息。'));
  body.append(node('p', 'resource-note', `${data.metadataType || '图片元数据'} · 可逐项复制，勾选控制「复制所选」。`));
  const selection = node('div', 'prompt-selection');
  const content = node('div');
  const selected = {};
  const groups = [
    ['positive', '正向提示词', Boolean(data.prompt || data.actualPrompt)],
    ['negative', '负向提示词', Boolean(data.negativePrompt || data.actualNegativePrompt)],
    ['characters', '角色提示词和位置', Boolean(data.characters?.length || data.negativeCharacters?.length || data.actualCharacters?.length || data.actualNegativeCharacters?.length)],
    ['settings', '模型与生成设置', Boolean(data.parameters || data.model)],
    ['seed', '种子', data.parameters?.seed !== undefined],
  ];
  for (const [key, label, available] of groups) {
    selected[key] = available;
    if (available) selection.append(checkOption(label, true, (checked) => { selected[key] = checked; renderFields(); }));
  }
  if (data.actualPrompt || data.actualNegativePrompt || data.actualCharacters?.length || data.actualNegativeCharacters?.length) {
    selection.append(checkOption('使用随机展开后的实际提示词', false, (checked) => { selected.actual = checked; renderFields(); }));
  }
  if (selection.childElementCount) body.append(selection);
  body.append(content);
  const rawFields = Object.entries(data.metadata || {});
  if (rawFields.length || data.rawComment) {
    const details = node('details', 'metadata-details');
    details.append(node('summary', '', '原始元数据'),
      button('复制全部原始元数据', 'soft compact', () => copy(rawFields.length ? data.metadata : data.rawComment)));
    const raw = node('dl', 'metadata-facts');
    for (const [key, value] of rawFields) appendCopyFact(raw, key, value, '空值', true);
    if (raw.childElementCount) details.append(raw);
    body.append(details);
  }

  function renderFields() {
    const generation = selectedGeneration(data, selected);
    content.replaceChildren();
    addCopyablePrompt(content, '正向提示词', generation.prompt);
    addCopyablePrompt(content, '负向提示词', generation.negativePrompt);
    renderCharacterPrompts(content, generation.characters, generation.negativeCharacters);
    const params = selectedGeneration(data, { settings: true, seed: true }).parameters;
    if (data.model && params.model == null) params.model = data.model;
    const settings = node('section', 'tool-section');
    settings.append(node('h2', '', '生成参数'));
    const facts = node('dl', 'metadata-facts');
    for (const key of new Set(['sampler', 'steps', ...Object.keys(parameterLabels), ...Object.keys(params)])) {
      appendCopyFact(facts, Object.prototype.hasOwnProperty.call(parameterLabels, key) ? parameterLabels[key] : key,
        Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined,
        ['sampler', 'steps'].includes(key) ? '原图未记录' : undefined, true);
    }
    settings.append(facts);
    if (Object.keys(params).length) settings.append(button('复制全部生成参数', 'soft compact', () => copy(params)));
    content.append(settings);
    const json = JSON.stringify(generation, null, 2);
    const chosen = groups.some(([key]) => selected[key]);
    actions.replaceChildren(button(galleryItem ? '返回原图' : sample ? '返回样图' : '另选原图', 'soft',
      back || (sample ? closeScreen : readImagePrompts)));
    const copySelection = button('复制所选', 'soft', () => copy(json));
    const save = button('收藏所选', 'primary', () => {
      if (new Blob([json]).size > 2 * 1024 * 1024 || generation.prompt.length > 16000) { toast('所选信息超过收藏上限，请保留原图。'); return; }
      const note = generation.negativePrompt && generation.negativePrompt.length < 7900
        ? '负向提示词：\n' + generation.negativePrompt : '已附带所选生成信息。';
      const source = resourcePhoto || {};
      showEditor({ section: 'knowledge', kind: 'general', title: sample ? '样图生成信息' : '原图生成信息',
        prompt: generation.prompt, note, photos: [], generation: json,
        source: source.source, sourceUrl: source.sourceUrl });
    });
    copySelection.disabled = save.disabled = !chosen;
    actions.append(copySelection, save);
  }
  renderFields();
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
      ['512', '512 MB'], ['1024', '1024 MB']], '256');
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
loadPersonal();
loadPacks();
checkForSavedDirectory();
checkAutomaticUpdate();
