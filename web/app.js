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
const sections = {
  character: { label: '同人角色', type: '角色标签', icon: 'character', subtitle: '按角色名查找 NovelAI 标签和效果。' },
  artist: { label: '画师', type: '画师标签', icon: 'artist', subtitle: '搜画师、看样图，收藏常用画风。' },
  knowledge: { label: '画面提示词知识', type: '提示词', icon: 'book', subtitle: '收好常用的动作、姿势和构图写法。' },
};
const state = {
  section: 'artist', mode: 'online', model: 'V5', kind: 'all', knowledgeTab: 'basic', artistSource: 'korean',
  limit: pageSize, online: null, onlineTask: null, onlineError: false, hasOnline: false,
  personal: [], personalError: false, packs: [], pack: null, packRows: [],
  packMessage: '', importing: false,
  korean: null, koreanTask: null, koreanError: false, koreanChecking: false, koreanStatus: '',
};
const knowledgeKinds = [['all', '全部'], ...PocketSources.knowledgeKinds];
let views = { artist: 'grid', character: 'grid', knowledge: 'list' };
try {
  const saved = JSON.parse(localStorage.getItem('pocket-views') || '{}');
  for (const key of Object.keys(views)) if (['grid', 'list', 'compact'].includes(saved[key])) views[key] = saved[key];
} catch { /* Default views work when preferences cannot be read. */ }
function isRemote() {
  return state.mode === 'online' && (state.section === 'knowledge' ? state.knowledgeTab === 'images'
    : state.section === 'artist' ? state.artistSource === 'nax' : true);
}

function isKorean() { return state.mode === 'online' && state.section === 'artist' && state.artistSource === 'korean'; }

function ensureKorean() {
  if (state.korean || state.koreanTask) return;
  state.koreanError = false;
  state.koreanTask = getJson('/api/korean.json').then((index) => { state.korean = PocketSources.koreanCards(index); })
    .catch(() => { state.koreanError = true; })
    .finally(() => { state.koreanTask = null; renderList(); });
}

async function checkKorean() {
  if (state.koreanChecking) return;
  state.koreanChecking = true;
  renderList();
  try {
    const response = await getJson('/api/korean-status.json?check=1');
    state.koreanStatus = response.message;
    toast(response.message);
  } catch { state.koreanStatus = '检查原库失败，请稍后重试。'; toast(state.koreanStatus); }
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
function native(action, value = null) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    if (!window.Pocket) {
      reject(new Error('请在安卓 App 中使用此功能。'));
      return;
    }
    pending.set(id, { resolve, reject });
    try {
      window.Pocket.request(JSON.stringify({ id, action, value }));
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

window.PocketResult = (id, value, error) => {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (error) request.reject(new Error(error));
  else request.resolve(value);
};

window.PocketProgress = (percentage) => {
  state.packMessage = percentage < 0 ? '正在建立索引…' : `正在建立索引 · ${percentage}%`;
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

async function copy(prompt) {
  try {
    if (window.Pocket) await native('copy', prompt);
    else await navigator.clipboard.writeText(prompt);
    toast('已复制');
  } catch (error) {
    toast(error.message || '复制失败，可以在详情里长按提示词。');
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
  state.limit = pageSize;
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

async function importPack() {
  if (state.importing) return;
  state.importing = true;
  state.packMessage = '请从手机文件中选择已有数据包…';
  render();
  try {
    const pack = await native('importPack');
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
    render();
  }
}

function chooseSection(section) {
  if (section === state.section) return;
  state.section = section;
  state.mode = 'online';
  state.kind = 'all';
  state.model = 'V5';
  if (section === 'artist') state.artistSource = 'korean';
  if (state.hasOnline && isRemote()) ensureOnline();
  resetResults();
}

function chooseMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.kind = 'all';
  if (isRemote() && state.hasOnline) ensureOnline();
  resetResults();
}

function resetResults() {
  query.value = '';
  state.limit = pageSize;
  main.scrollTop = 0;
  render();
}

function chip(label, selected, click) {
  const el = button(label, 'chip', click);
  el.setAttribute('aria-pressed', String(selected));
  return el;
}

function render() {
  const current = sections[state.section];
  byId('eyebrow').textContent = 'NOVELAI / 掌上词库';
  byId('title').textContent = state.section === 'artist' ? '画师库' : current.label;
  byId('subtitle').textContent = current.subtitle;
  byId('personal').setAttribute('aria-pressed', String(state.mode === 'personal'));
  byId('online').setAttribute('aria-pressed', String(state.mode === 'online'));
  byId('online').textContent = state.section === 'knowledge' ? '知识与资源' : '在线资源';
  query.placeholder = state.section === 'knowledge' ? '搜动作、标题或提示词' : `搜索${current.type}`;
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
      if (id === 'imported') selectPack(state.pack?.id || state.packs[0]?.id);
      else if (id === 'korean') ensureKorean();
      else if (state.hasOnline) ensureOnline();
      resetResults();
    }));
  }
  if (state.section === 'knowledge') {
    if (state.mode === 'online') {
      for (const [value, label] of [['basic', '中文知识'], ['images', '在线图鉴'], ['references', '原帖资料']]) {
        resourceTabs.append(chip(label, state.knowledgeTab === value, () => {
          state.knowledgeTab = value;
          state.kind = 'all';
          state.limit = pageSize;
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
        state.limit = pageSize;
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
          state.limit = pageSize;
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
  const viewOptions = byId('view-options');
  viewOptions.replaceChildren(node('span', '', '显示'));
  for (const [value, label] of [['grid', '双列看图'], ['list', '图文列表'], ['compact', '紧凑文字']]) {
    viewOptions.append(chip(label, views[state.section] === value, () => {
      views[state.section] = value;
      try { localStorage.setItem('pocket-views', JSON.stringify(views)); } catch { /* In-memory choice still works. */ }
      render();
    }));
  }
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
  const view = views[state.section];
  const grid = view === 'grid';
  const item = node('article', grid ? 'card' : 'row');
  const hit = button(card.title, grid ? 'card-main' : 'row-main', () => showCard(card));
  const mark = node('span', 'row-mark');
  mark.append(icon(sections[card.section].icon));
  const text = node('span', 'row-text');
  const caption = card.section === 'knowledge'
    ? [knowledgeKinds.find(([key]) => key === card.kind)?.[1] || '通用写法', card.prompt || card.source]
    : [card.model, card.source || (card.photos.length ? '有配图' : '自建')];
  text.append(node('span', 'row-title', card.title), node('span', 'row-caption', caption.filter(Boolean).join(' · ')));
  if (card.section === 'knowledge' && card.note && view !== 'compact') text.append(node('span', 'row-note', card.note));
  hit.replaceChildren(view === 'compact' || (view === 'list' && !card.photos.length) ? mark : thumbnail(card, grid), text);
  item.append(hit);
  if (card.prompt) item.append(button(`复制 ${card.title}`, 'icon-button', () => copy(card.prompt), 'copy'));
  else item.append(button(`查看 ${card.title}`, 'icon-button', () => showCard(card), 'arrow'));
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
    results.append(node('p', 'resource-note', state.koreanStatus || '韩国原版 V5 · bequiet 精选 6,145 位画师，原图按需加载。'));
    const check = button(state.koreanChecking ? '检查中…' : '检查韩国原库更新', 'text-button', checkKorean);
    check.disabled = state.koreanChecking;
    meta.append(check);
    if (!state.korean) {
      empty(state.koreanError ? '主库目录读取失败' : '正在打开韩国主库', '无需下载完整原包。', ...(state.koreanError ? [button('重试', 'soft', () => { ensureKorean(); renderList(); })] : []));
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
    const importer = button(state.importing ? '导入中…' : '导入已有数据包', 'text-button', importPack);
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
  const terms = query.value.trim().toLocaleLowerCase().replaceAll('_', ' ').split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
  const matching = source.filter((card) => {
    if (card.section !== state.section || (remote && card.model !== state.model)) return false;
    if (knowledge && state.kind !== 'all' && card.kind !== state.kind) return false;
    if (!terms.length) return true;
    const words = [card.title, card.prompt, card.note].join(' ').toLocaleLowerCase().replaceAll('_', ' ');
    return terms.every((term) => words.includes(term));
  });
  meta.prepend(node('span', '', `${number.format(matching.length)} 条`));
  if (!matching.length) {
    if (terms.length) empty('没有匹配的条目', '试试更短的关键词，或切换模型。', button('清除搜索', 'soft', resetResults));
    else if (personal) empty('从一条常用词开始', '保存后随时搜索、编辑或复制。', button('新增条目', 'soft', () => showEditor()), button('看看在线资源', 'subtle', () => chooseMode('online')));
    else empty('这里还没有条目', knowledge && remote ? '在线图鉴目前只有发型和表情；V5 暂无表情图库。可切换模型或进入中文知识查看其他分类。' : '可以切换分类，或重新导入已有数据包。');
    return;
  }
  const list = node('div', views[state.section] === 'grid' ? 'gallery' : 'list');
  list.append(...matching.slice(0, state.limit).map(row));
  results.append(list);
  if (matching.length > state.limit) {
    results.append(button('再显示 ' + Math.min(pageSize, matching.length - state.limit) + ' 条', 'soft more', () => {
      state.limit += pageSize;
      renderList();
    }));
  }
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

function openScreen(title) {
  byId('screen-title').textContent = title;
  body.replaceChildren();
  actions.replaceChildren();
  if (!screen.open) screen.showModal();
  body.scrollTop = 0;
}

function closeScreen() {
  screen.close();
  body.replaceChildren();
  actions.replaceChildren();
}

function showPhotos(card) {
  if (!card.photos.length) return;
  const photo = node('div', 'photo');
  const label = node('span', '');
  let index = 0;
  function show() {
    const ref = card.photos[index];
    label.textContent = `${index + 1} / ${card.photos.length} · ${ref.label || '配图'}`;
    const status = node('span', '', '正在读取预览…');
    const img = node('img', '');
    img.alt = card.title + ' · ' + (ref.label || '配图');
    img.hidden = true;
    img.onload = () => { img.hidden = false; status.remove(); };
    img.onerror = () => {
      if (img.parentNode === photo) photo.replaceChildren(button('预览读取失败 · 重试', 'soft', show));
    };
    photo.replaceChildren(status, img);
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
  body.append(photo, controls);
  show();
}

function showCard(card) {
  openScreen('条目详情');
  body.append(node('h2', '', card.title));
  const badges = node('div', 'badges');
  for (const value of [sections[card.section].label, card.model, card.source].filter(Boolean)) {
    badges.append(node('span', 'badge', value));
  }
  body.append(badges);
  showPhotos(card);
  if (card.prompt) body.append(node('div', 'prompt', card.prompt));
  if (card.note) body.append(node('p', 'detail-note', card.note));
  if (card.generation) {
    const details = node('details', 'metadata-details');
    details.append(node('summary', '', '原图完整生成信息'), node('pre', 'prompt', card.generation), button('复制完整信息', 'soft', () => copy(card.generation)));
    body.append(details);
  }
  if (card.sourceUrl) {
    const credit = node('p', 'source-info', card.license ? '示例图 · Carlyone / NAX · CC BY 4.0' : '');
    credit.append(button('查看来源', 'text-button', () => openLink(card.sourceUrl)));
    body.append(credit);
  }
  if (card.prompt) actions.append(button('复制提示词', 'primary', () => copy(card.prompt)));
  if (card.local) actions.append(button('编辑', 'soft', () => showEditor(card)));
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
  return [card.section, card.model || '通用', (card.prompt || '').trim().normalize('NFC').toLowerCase().replace(/^artist:\s*/, '').replaceAll('_', ' ').replace(/\s+/g, ' ')].join('|');
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
    };
    const duplicate = section !== 'knowledge' && state.personal.find((saved) => saved.id !== card.id && cardIdentity(saved) === cardIdentity(card));
    if (duplicate) { save.disabled = false; toast('该模型下已有相同标签，请编辑已有条目。'); return; }
    try {
      await useCards('readwrite', (store) => store.put(card));
      closeScreen();
      state.section = section;
      state.mode = 'personal';
      state.kind = 'all';
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
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(url)
    || /^\/nax-image\/[a-z0-9.-]+\/[^/?#]+(?:\?rev=[^#]*)?$/.test(url)
    || /^\/pack-image\/[a-zA-Z0-9-]+\/\d+\/\d+$/.test(url)
    || /^\/korean-image\/\d+\/\d+$/.test(url));
  const text = (value, max, optional = true) => (optional && value === undefined) || (typeof value === 'string' && value.length <= max);
  return data.cards.map((card) => {
    if (!card || typeof card !== 'object' || !text(card.id, 500, false) || !card.id || ids.has(card.id)
      || !Object.hasOwn(sections, card.section) || !text(card.title, 400, false)
      || !text(card.prompt, 16000) || !text(card.note, 8000) || !text(card.model, 40)
      || !text(card.source, 500) || !text(card.sourceUrl, 2000) || !text(card.from, 1000) || !text(card.license, 100)
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
  try {
    const data = await native('readImagePrompts');
    if (!data) return;
    openScreen('原图提示词');
    if (!data.found) {
      body.append(node('h2', '', '没有读到提示词'), node('p', 'detail-note', data.message || '图片可能没有保留生成信息。请使用生成时下载的原始 PNG，截图和压缩后的图片通常无法读取。'));
      actions.append(button('重新选图', 'primary', readImagePrompts));
      return;
    }
    body.append(node('p', 'resource-note', '只读取图片文件中已有的信息，不会上传图片，也不会猜测被清除的提示词。'));
    const addPrompt = (label, value) => {
      if (!value) return;
      const section = toolSection(label, '');
      section.append(node('div', 'prompt', value), button('复制' + label, 'soft', () => copy(value)));
    };
    addPrompt('正向提示词', data.prompt);
    addPrompt('负向提示词', data.negativePrompt);
    if (data.model) body.append(node('p', 'detail-note', '模型 / 来源：' + data.model));
    if (data.characters) {
      const chars = typeof data.characters === 'string' ? data.characters : JSON.stringify(data.characters, null, 2);
      if (chars !== '[]' && chars !== '{}') addPrompt('角色与位置', chars);
    }
    if (data.negativeCharacters) {
      const chars = typeof data.negativeCharacters === 'string' ? data.negativeCharacters : JSON.stringify(data.negativeCharacters, null, 2);
      if (chars !== '[]' && chars !== '{}') addPrompt('角色负向提示', chars);
    }
    if (data.rawComment) {
      const details = node('details', 'metadata-details');
      details.append(node('summary', '', '查看完整生成参数'), node('pre', 'prompt', data.rawComment), button('复制完整参数', 'soft', () => copy(data.rawComment)));
      body.append(details);
    }
    actions.append(button('另选原图', 'soft', readImagePrompts));
    if (data.prompt && data.prompt.length <= 16000) actions.append(button('收藏提示词', 'primary', () => {
      const generation = JSON.stringify({ prompt: data.prompt, negativePrompt: data.negativePrompt, model: data.model,
        parameters: data.parameters, characters: data.characters, negativeCharacters: data.negativeCharacters,
        v4Prompt: data.v4Prompt, v4NegativePrompt: data.v4NegativePrompt, rawComment: data.parameters ? undefined : data.rawComment }, null, 2);
      if (new Blob([generation]).size > 2 * 1024 * 1024) { toast('完整参数超过收藏上限，请保留原图文件。'); return; }
      const note = data.negativePrompt && data.negativePrompt.length <= 7900 ? '负向提示词：\n' + data.negativePrompt : '完整正负提示词、角色信息和参数已保存在本条目的生成信息中。';
      showEditor({ section: 'knowledge', kind: 'general', title: '原图提示词', prompt: data.prompt,
        note, photos: [], generation });
    }));
    else if (data.prompt) body.append(node('p', 'resource-note', '正向提示词超过编辑器上限，本次可查看和复制，请保留原始图片。'));
  } catch (error) { toast(error.message || '读取原图失败。'); }
}

function showTools() {
  openScreen('设置与工具');
  const image = toolSection('读取原图提示词', '选择原始 PNG，读取保留在图片中的正向、负向提示词和生成参数。全程在本机处理。');
  image.append(button('选择原图', 'primary', readImagePrompts));
  const backup = toolSection('个人词库备份', '导出收藏、自己写的条目和自选配图，换机时可以恢复。在线图片和导入的数据包只保留引用，不会打包进去。');
  const backupActions = node('div', 'tool-actions');
  backupActions.append(button('导出备份', 'soft', exportBackup), button('从备份恢复', 'soft', importBackup));
  backup.append(backupActions);
  const update = toolSection('应用版本更新', '通过 GitHub 发布页检查新版。发现新版后在浏览器下载 APK，再由安卓确认安装。');
  const version = node('p', 'detail-note', '正在读取版本…');
  const repo = textInput('input', '', 'owner/repo 或 GitHub 仓库链接', 300);
  const result = node('div', 'update-result');
  result.setAttribute('aria-live', 'polite');
  const controls = node('div', 'tool-actions');
  const saveRepo = button('保存地址', 'soft', async () => {
    try {
      const info = await native('setUpdateRepository', repo.value.trim());
      repo.value = info.repository;
      result.replaceChildren(node('p', '', info.repository ? '仓库地址已保存，可以检查新版。' : '尚未配置发布仓库。'));
    } catch (error) { toast(error.message); }
  });
  const check = button('检查应用更新', 'primary', async () => {
    check.disabled = true;
    result.replaceChildren(node('p', '', '正在检查 GitHub 发布版本…'));
    try {
      const info = await native('checkAppUpdate');
      result.replaceChildren(node('p', '', info.message));
      if (info.available && info.downloadUrl) {
        if (info.body) result.append(node('p', 'release-notes', info.body));
        result.append(button('下载新版 APK', 'primary', () => native('openAppRelease', 'download').catch((error) => toast(error.message))));
      }
      if (info.releaseUrl) result.append(button('查看发布页', 'text-button', () => native('openAppRelease', 'release').catch((error) => toast(error.message))));
    } catch (error) { result.replaceChildren(node('p', '', error.message)); }
    finally { check.disabled = false; }
  });
  controls.append(saveRepo, check);
  update.append(version, field('GitHub 发布仓库', repo), controls, result);
  if (window.Pocket) native('appInfo').then((info) => {
    version.textContent = '当前版本 ' + info.versionName;
    repo.value = info.repository || '';
    if (!info.repository) result.append(node('p', '', '发布仓库尚未配置，当前无法检查新版。'));
  }).catch((error) => { version.textContent = error.message; });
  else {
    version.textContent = '当前为浏览器预览，安卓 App 中可检查版本。';
    saveRepo.disabled = check.disabled = true;
  }
  const thanks = toolSection('来源与感谢', '感谢韩国 Arca Live 社区作者 bequiet / baqu2213 分享原版画师库和查看器；感谢 Carlyone 的 NAX 图库，以及韩国社区和 NovelAI 官方资料。');
  thanks.append(button('原版画师资源', 'text-button', () => openLink('https://arca.live/b/aiart/185691299')),
    button('NAX · CC BY 4.0', 'text-button', () => openLink(PocketSources.nax)));
}

byId('tools').addEventListener('click', showTools);
byId('add').addEventListener('click', () => showEditor());
byId('close').addEventListener('click', closeScreen);
byId('personal').addEventListener('click', () => chooseMode('personal'));
byId('online').addEventListener('click', () => chooseMode('online'));
byId('nav').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-section]');
  if (tab) chooseSection(tab.dataset.section);
});
let queryTimer;
query.addEventListener('input', () => {
  state.limit = pageSize;
  clearTimeout(queryTimer);
  queryTimer = setTimeout(renderList, 80);
});
screen.addEventListener('cancel', (event) => { event.preventDefault(); closeScreen(); });
window.PocketBack = () => {
  if (screen.open) { closeScreen(); return true; }
  if (state.mode === 'online') { chooseMode('personal'); return true; }
  return false;
};

ensureKorean();
render();
loadPersonal();
loadPacks();
checkForSavedDirectory();
