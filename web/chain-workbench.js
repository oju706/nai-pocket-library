'use strict';

// Artist-chain schema, persistence, sampling, and workbench interactions.
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

function artistTagKey(value) {
  return unescapeTagPunctuation(String(value ?? '').normalize('NFKC'))
    .replace(/[_\s]+/g, ' ').replace(/ *([()]) */g, '$1').trim().toLocaleLowerCase();
}

function unescapeTagPunctuation(value) {
  return value.replace(/\\([\\(),_])/g, '$1');
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
  const values = readJsonStorageOr(artistDrawHistoryKey(context, pool), []);
  return new Set(Array.isArray(values) ? values.map((value) => searchText(value)).filter(Boolean) : []);
}

function writeArtistDrawHistory(context, pool, seen) {
  writeJsonStorage(artistDrawHistoryKey(context, pool), [...seen]);
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
    compareThirdCopyIds: { V5: null, 'V4.5': null },
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

function isArtistChainWeight(value) {
  return Number.isFinite(value) && value >= 0 && value <= 3
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function artistChainWeightLabel(weight) {
  return weight.toFixed(Math.round(weight * 100) % 10 ? 2 : 1);
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
        || (entry.disabled !== undefined && typeof entry.disabled !== 'boolean')
        || (entry.locked !== undefined && typeof entry.locked !== 'boolean')) {
      throw new Error('画风串草稿条目不正确。');
    }
    const normalized = normalizeArtistChainTag(entry.tag, { escapeCommas: true });
    if (normalized.error || !isArtistChainWeight(entry.weight) || keys.has(normalized.key)) {
      throw new Error('画风串草稿含无效的标签、倍率或重复项。');
    }
    keys.add(normalized.key);
    items.push({
      tag: normalized.tag,
      key: normalized.key,
      weight: entry.weight,
      disabled: entry.disabled === true,
      locked: entry.locked === true,
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
    const thirdId = value.compareThirdCopyIds?.[model];
    const third = copies.find((copy) => copy.id === thirdId && copy.id !== active.id && copy.id !== compare?.id);
    result.copies[model] = copies;
    result.activeCopyIds[model] = active.id;
    result.drafts[model] = active.items;
    result.compareCopyIds[model] = compare?.id || null;
    result.compareThirdCopyIds[model] = third?.id || null;
  }
  return result;
}

function loadArtistChainDraft({ fresh = false } = {}) {
  if (artistChainDraftCache && !fresh) return artistChainDraftCache;
  artistChainStorageUnavailable = false;
  try {
    const stored = readJsonStorageEntry(artistChainStorageKey);
    if (stored.present) {
      artistChainDraftCache = normalizeArtistChainDraft(stored.value);
      artistChainStorageMessage = '已从本机恢复画风串草稿与副本。';
    } else {
      const legacy = readJsonStorageEntry(artistChainLegacyStorageKey);
      if (legacy.present) {
        artistChainDraftCache = upgradeLegacyArtistChainDraft(legacy.value);
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
  const storedItems = (items) => items.map(({ tag, weight, disabled, locked }) => ({
    tag, weight, ...(disabled ? { disabled: true } : {}), ...(locked ? { locked: true } : {}),
  }));
  const value = {
    format: draft.format,
    version: draft.version,
    selectedModel: draft.selectedModel,
    drafts: Object.fromEntries(artistChainModels.map((model) => [model, storedItems(draft.drafts[model])])),
    copies: Object.fromEntries(artistChainModels.map((model) => [model, draft.copies[model].map((copy) => ({
      id: copy.id,
      name: copy.name,
      items: storedItems(copy.items),
    }))])),
    activeCopyIds: { ...draft.activeCopyIds },
    compareCopyIds: { ...draft.compareCopyIds },
    compareThirdCopyIds: { ...draft.compareThirdCopyIds },
    nextCopyId: draft.nextCopyId,
  };
  if (writeJsonStorage(artistChainStorageKey, value)) {
    artistChainStorageUnavailable = false;
    artistChainStorageMessage = '草稿已自动保存到本机。';
    return true;
  }
  artistChainStorageUnavailable = true;
  artistChainStorageMessage = '本机草稿写入失败；当前会话仍可继续使用。';
  return false;
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
    return item.weight === 1 ? name : `${artistChainWeightLabel(item.weight)}::${name} ::`;
  }).join(', ');
}

function normalizeEnabledArtistWeights(items) {
  const enabled = items.filter((item) => !item.disabled);
  if (!enabled.length) return { error: '先启用至少一位画师。' };
  const adjustable = enabled.filter((item) => !item.locked);
  const freeUnits = adjustable.reduce((sum, item) => sum + Math.round(item.weight * 100), 0);
  const lockedUnits = enabled.reduce((sum, item) => sum + (item.locked ? Math.round(item.weight * 100) : 0), 0);
  const target = enabled.length * 100 - lockedUnits;
  if (target < 0) return { error: '锁定倍率之和已超过目标。请先调整锁定项。' };
  if (!freeUnits) {
    return target ? { error: '请先为至少一位未锁定画师设置正倍率。' } : { changed: false };
  }
  const shares = adjustable.map((item) => {
    const ideal = Math.round(item.weight * 100) * target;
    return { item, units: Math.floor(ideal / freeUnits), remainder: ideal % freeUnits };
  });
  if (shares.some(({ units, remainder }) => units > 300 || (units === 300 && remainder))) {
    return { error: '按原比例调整会让个别倍率超过 3。请先调整倍率或锁定项。' };
  }
  let remainder = target - shares.reduce((sum, share) => sum + share.units, 0);
  shares.sort((left, right) => right.remainder - left.remainder);
  for (const share of shares) {
    if (!remainder) break;
    share.units++;
    remainder--;
  }
  const changed = shares.some(({ item, units }) => item.weight !== units / 100);
  for (const { item, units } of shares) item.weight = units / 100;
  return { changed };
}

function currentArtistChain() {
  const draft = loadArtistChainDraft();
  const model = artistChainModels.includes(draft.selectedModel) ? draft.selectedModel : 'V5';
  const copy = activeArtistChainCopy(draft, model);
  return { model, name: copy.name, items: copy.items };
}

function copyCurrentArtistChain() {
  const value = artistChainPrompt(currentArtistChain().items);
  if (value) copy(value);
}

function refreshArtistChainShortcuts() {
  const shortcuts = byId('artist-discovery');
  const open = shortcuts?.querySelector('.artist-chain-quick-open');
  const quickCopy = shortcuts?.querySelector('.artist-chain-quick-copy');
  if (!open || !quickCopy) return;
  const { model, name, items } = currentArtistChain();
  const enabled = items.filter((item) => !item.disabled).length;
  open.textContent = items.length ? `画风串 · ${items.length}` : '画风串';
  open.title = `${model} · ${name} · ${enabled} 位启用`;
  quickCopy.textContent = `复制 ${model} 画风串`;
  quickCopy.title = `复制「${name}」中启用的画师标签`;
  quickCopy.hidden = enabled === 0;
  byId('artist-dock-status').textContent = `${model} · ${enabled}/${items.length} 启用`;
  const dockCopy = byId('artist-dock-copy');
  dockCopy.disabled = enabled === 0;
  dockCopy.setAttribute('aria-label', quickCopy.title);
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
  if (draft.compareThirdCopyIds[model] === copy.id) draft.compareThirdCopyIds[model] = null;
  return true;
}

function createArtistChainCopy(draft, model, name, items) {
  const id = `copy-${model.replace(/[^A-Za-z0-9]/g, '')}-${draft.nextCopyId++}`;
  const copy = {
    id,
    name,
    items: items.map(({ tag, key, weight, disabled, locked }) => ({ tag, key, weight, disabled, locked })),
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
  catalog = null, targetModel = '', requireCatalog = false, weight = 1,
} = {}) {
  if (!draft?.drafts || !artistChainModels.includes(model) || !Array.isArray(draft.drafts[model])) {
    return { error: '画风串模型草稿不可用。' };
  }
  if (requireCatalog && !catalog) return { error: '画师目录尚未就绪，请稍候。' };
  if (!isArtistChainWeight(weight)) return { error: '倍率需在 0–3 之间，最多两位小数。' };
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
  const item = { tag: entry.tag, key: entry.key, weight, disabled: false, locked: false };
  items.push(item);
  return { added: true, item, tag: entry.tag, key: entry.key, card: entry.card || null };
}

function addArtistCardsToChain(cards, draft, targetModel, weights = null) {
  let added = 0;
  let duplicates = 0;
  let capacity = 0;
  let invalid = 0;
  for (const card of cards) {
    const tag = artistChainCardTag(card);
    const result = enqueueArtistChainTag(draft, targetModel, tag, { weight: weights?.get(card) });
    if (result.added) added++;
    else if (result.duplicate) duplicates++;
    else if (result.capacity) capacity++;
    else invalid++;
  }
  return { added, duplicates, capacity, invalid };
}

function openArtistChainWorkbench({
  back = null, defaultModel = null, initialArtists = [], initialTag = '', originalWeights = null, skippedWeights = 0,
} = {}) {
  openScreen('画风串工作台', back);
  screen.classList.add('artist-chain-screen');
  document.querySelector('.screen-inner')?.classList.add('artist-chain-open');
  const revision = screenRevision;
  let draft = loadArtistChainDraft();
  let activeModel = artistChainModels.includes(defaultModel) ? defaultModel
    : artistChainModels.includes(draft.selectedModel) ? draft.selectedModel : 'V5';
  draft.selectedModel = activeModel;
  const addition = addArtistCardsToChain(initialArtists, draft, activeModel, originalWeights);
  if (initialArtists.length) persistArtistChainDraft(draft);

  let koreanResults = [];
  let importedResults = [];
  let catalog = promptArtistCatalog([], { loading: true });
  let catalogLoading = true;
  const workbench = node('div', 'artist-chain-workbench');
  const intro = node('p', 'resource-note',
    'V5 与 V4.5 各有独立草稿。停用会保留标签和倍率，复制整串时跳过该画师。');
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
    `每个模型最多 ${artistChainCopiesPerModel} 份。副本会保存倍率、锁定和停用状态。`);
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

  const feedback = node('p', 'artist-chain-feedback');
  feedback.id = 'artist-chain-feedback';
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
  const weightTotal = node('span', 'muted');
  const normalizeButton = button('平均倍率归一到 1', 'soft compact', () => {
    const result = normalizeEnabledArtistWeights(draft.drafts[activeModel]);
    if (result.changed) {
      saveDraft();
      renderDraft();
    }
    toast(result.error || (result.changed ? '启用画师的平均倍率已归一到 1。' : '当前平均倍率已经是 1。'));
  });
  normalizeButton.title = '保留已锁定的倍率，其余启用画师按比例调整。';
  const normalization = node('div', 'artist-chain-normalization');
  normalization.append(weightTotal, normalizeButton);
  const copyButton = button('复制整串', 'primary artist-chain-copy-button', () => {
    const value = artistChainPrompt(draft.drafts[activeModel]);
    if (value) copy(value);
  });
  const saveStatus = node('p', 'artist-chain-save-status', artistChainStorageMessage || '草稿会自动保存在本机。');
  saveStatus.setAttribute('role', 'status');
  side.append(previewHeading, preview, normalization, saveStatus);
  layout.append(editor, side);

  const comparison = node('section', 'artist-chain-compare');
  const comparisonHeading = node('div', 'artist-chain-compare-heading');
  comparisonHeading.append(node('h2', '', 'A/B/C 草稿对比'));
  const compareSelectors = ['B', 'C'].map((letter) => {
    const field = node('label', 'artist-chain-copy-field');
    const select = node('select');
    select.setAttribute('aria-label', `选择草稿 ${letter}`);
    field.append(node('span', '', `草稿 ${letter}`), select);
    comparisonHeading.append(field);
    return { letter, select };
  });
  const comparisonStatus = node('p', 'artist-chain-compare-status');
  comparisonStatus.setAttribute('role', 'status');
  const comparisonGrid = node('div', 'artist-chain-compare-grid');
  comparison.append(comparisonHeading, comparisonStatus, comparisonGrid);

  workbench.append(intro, modelControls, copiesSection, layout, comparison);
  body.append(workbench);
  const galleryButton = button('用当前画风串找图', 'soft', () => {
    const value = draft.drafts[activeModel].filter((item) => !item.disabled)
      .map((item) => PocketSources.tagGalleryTag(item.tag)).filter(Boolean).join(' ');
    if (!value) {
      toast('当前草稿没有启用的画师标签。');
      return;
    }
    showTagGalleries(value, () => openArtistChainWorkbench({
      back,
      defaultModel: activeModel,
    }));
  });
  galleryButton.classList.add('artist-chain-gallery-button');
  actions.append(galleryButton, copyButton);

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
      : `每个模型最多 ${artistChainCopiesPerModel} 份。副本会保存倍率、锁定和停用状态。`;
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
    const totalUnits = items.reduce((sum, item) => sum + (item.disabled ? 0 : Math.round(item.weight * 100)), 0);
    weightTotal.textContent = `启用项总倍率 ${artistChainWeightLabel(totalUnits / 100)}`;
    normalizeButton.disabled = !enabled;
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
    const activeCopy = activeArtistChainCopy(draft, activeModel);
    const others = draft.copies[activeModel].filter((copy) => copy.id !== activeCopy.id);
    const bId = draft.compareCopyIds[activeModel];
    const cId = draft.compareThirdCopyIds[activeModel];
    const cards = [];
    for (const { letter, select } of compareSelectors) {
      const selectedId = letter === 'B' ? bId : cId;
      const candidates = others.filter((copy) => copy.id !== (letter === 'B' ? cId : bId));
      const selectedCopy = candidates.find((copy) => copy.id === selectedId);
      const choices = [['', candidates.length ? '选择同模型草稿' : '暂无其他草稿']];
      choices.push(...candidates.map((copy) => [copy.id, copy.name]));
      select.replaceChildren(...choices.map(([id, name]) => {
        const option = node('option', '', name);
        option.value = id;
        return option;
      }));
      select.disabled = !candidates.length;
      select.value = selectedCopy?.id || '';
      if (selectedCopy) {
        const card = comparisonCard(letter, selectedCopy);
        card.append(comparisonChanges(activeCopy, selectedCopy, letter));
        cards.push(card);
      }
    }
    comparisonStatus.textContent = others.length
      ? `A 是当前「${activeCopy.name}」。选择同模型的副本查看与 A 的差异。`
      : '另存一份副本即可开始对比。';
    comparisonGrid.replaceChildren(...(cards.length ? [comparisonCard('A', activeCopy), ...cards] : []));
    comparisonGrid.classList.toggle('has-three', cards.length === 2);
  }

  function comparisonChanges(activeCopy, other, letter) {
    const diff = node('div', 'artist-chain-compare-diff');
    const changes = compareArtistChainCopies(activeCopy.items, other.items);
    if (!Object.values(changes).some((items) => items.length)) {
      diff.append(node('p', 'artist-chain-compare-same', '画师、倍率与停用状态和 A 一致。'));
      return diff;
    }
    diff.append(node('h4', '', `A → ${letter} 的差异`));
    const appendGroup = (title, lines) => {
      if (!lines.length) return;
      const group = node('div', 'artist-chain-compare-group');
      const list = node('ul');
      for (const line of lines) list.append(node('li', '', line));
      group.append(node('h5', '', title), list);
      diff.append(group);
    };
    appendGroup('新增', changes.removed.map((item) => item.tag));
    appendGroup('移除', changes.added.map((item) => item.tag));
    appendGroup('倍率变化', changes.weights.map(({ item, other: match }) =>
      `${item.tag}：${artistChainWeightLabel(item.weight)}× → ${artistChainWeightLabel(match.weight)}×`));
    appendGroup('启用状态变化', changes.disabled.map(({ item, other: match }) =>
      `${item.tag}：${item.disabled ? '停用' : '启用'} → ${match.disabled ? '停用' : '启用'}`));
    return diff;
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
      const title = node('div', 'artist-chain-item-title');
      title.append(node('strong', '', item.tag));
      if (item.locked) title.append(node('small', 'muted', '倍率已锁定'));
      tagDictionaryAppend(title, item.tag, () => row.isConnected && revision === screenRevision);
      heading.append(title, node('small', 'muted', `第 ${index + 1} 位${item.disabled ? ' · 已停用' : ''}`));
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
      const lock = button(item.locked ? '解锁倍率' : '锁定倍率', 'soft compact', () => {
        item.locked = !item.locked;
        saveDraft();
        renderDraft();
        list.children[index]?.querySelector('.artist-chain-weight-lock')?.focus();
      });
      lock.classList.add('artist-chain-weight-lock');
      lock.setAttribute('aria-label', `${item.locked ? '解锁' : '锁定'} ${item.tag} 的倍率`);
      up.disabled = index === 0;
      down.disabled = index === items.length - 1;
      controls.append(up, down, lock, toggle, remove);

      const weightGroup = node('div', 'artist-chain-weight');
      const decrease = button('−', 'icon-button', () => updateWeight(item.weight - .1));
      decrease.setAttribute('aria-label', `降低 ${item.tag} 的倍率`);
      const weight = node('input', 'artist-chain-weight-input');
      weight.type = 'number';
      weight.inputMode = 'decimal';
      weight.min = '0';
      weight.max = '3';
      weight.step = '0.01';
      weight.value = artistChainWeightLabel(item.weight);
      weight.disabled = item.locked;
      weight.setAttribute('aria-label', `${item.tag} 的倍率，范围 0 到 3，最多两位小数`);
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
        preset.disabled = item.locked;
        presets.append(preset);
        return [value, preset];
      });
      function updateWeight(next, { syncInput = true, announce = true } = {}) {
        const numeric = Number(next);
        if (item.locked || !Number.isFinite(numeric)) return;
        item.weight = Math.min(3, Math.max(0, Math.round(numeric * 100) / 100));
        if (syncInput) {
          weight.value = artistChainWeightLabel(item.weight);
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
        if (announce) setFeedback(`已将 ${item.tag} 设为 ${artistChainWeightLabel(item.weight)} 倍。`);
      }
      decrease.disabled = item.locked || item.weight === 0;
      increase.disabled = item.locked || item.weight === 3;
      weight.addEventListener('input', () => {
        const raw = weight.value.trim();
        if (!raw) return;
        const next = Number(raw);
        const valid = isArtistChainWeight(next);
        weight.setAttribute('aria-invalid', String(!valid));
        if (!valid) {
          setFeedback(`倍率需在 0–3 之间，最多两位小数。当前仍保留 ${artistChainWeightLabel(item.weight)}。`, true);
          return;
        }
        updateWeight(next, { syncInput: false });
      });
      weight.addEventListener('blur', () => {
        weight.value = artistChainWeightLabel(item.weight);
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

  for (const { letter, select } of compareSelectors) {
    select.addEventListener('change', () => {
      const selection = letter === 'B' ? draft.compareCopyIds : draft.compareThirdCopyIds;
      selection[activeModel] = select.value || null;
      saveDraft();
      renderComparison();
    });
  }

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
    if (draft.compareThirdCopyIds[activeModel] === previousCopy.id) draft.compareThirdCopyIds[activeModel] = null;
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
      tagDictionaryAppend(label, tag, () => label.isConnected && revision === screenRevision);
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
  let pendingInitialTag = String(initialTag || '').normalize('NFKC').trim();
  function refreshArtistChoices() {
    if (revision !== screenRevision) return;
    catalog = promptArtistCatalog(koreanResults, { loading: catalogLoading, importedResults });
    if (catalogLoading) return;
    add.disabled = false;
    catalogStatus.textContent = `已载入 ${number.format(catalog.index.size)} 个完整画师标签 · ${promptArtistCatalogNote(catalog)}。`;
    renderArtistChoices();
    if (pendingInitialTag && !input.value.trim()) {
      const result = enqueueArtistChainTag(draft, activeModel, pendingInitialTag, {
        catalog, targetModel: activeModel, requireCatalog: true,
      });
      input.value = pendingInitialTag;
      pendingInitialTag = '';
      if (result.added) finishArtistAddition(result);
      else {
        setFeedback(result.error, true);
        renderArtistChoices();
      }
    }
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
    if (pendingInitialTag) {
      input.value = pendingInitialTag;
      pendingInitialTag = '';
      setFeedback('图站画师标签已放入输入框；目录读取失败，请稍后手动校验。', true);
    }
  });
  loadSavedNaxDirectory(revision)?.then(() => {
    if (state.online) refreshArtistChoices();
  }).catch(() => { /* The bundled and imported catalogs remain available. */ });
  loadImportedArtistCatalogs().then((results) => {
    importedResults = results;
    if (results.length) refreshArtistChoices();
  });

  if (addition.added || addition.duplicates || addition.capacity || skippedWeights || addition.invalid) {
    const parts = [];
    if (addition.added) parts.push(`已加入 ${addition.added} 位画师`);
    if (addition.duplicates) parts.push(`${addition.duplicates} 位已在当前草稿`);
    if (addition.capacity) parts.push(`${activeModel} 草稿已达到 ${artistChainCapacity} 位上限`);
    if (skippedWeights || addition.invalid) parts.push(`跳过 ${skippedWeights + addition.invalid} 位倍率或标签无法确认的画师`);
    if (originalWeights) setFeedback(parts.join('。') + '。');
    toast(parts.join('；'));
  }
}

function artistChainCardTag(card) {
  const explicit = extractPromptTags(card?.prompt).filter((item) => item.explicit);
  if (explicit.length === 1) {
    const fromPrompt = normalizeArtistChainTag(explicit[0].name, { escapeCommas: true });
    if (!fromPrompt.error) return fromPrompt.tag;
  }
  if (isDanbooruTagFavorite(card)) return artistCardTag(card);
  const fromTitle = normalizeArtistChainTag(card?.title, { escapeCommas: true });
  return fromTitle.error ? '' : fromTitle.tag;
}

window.PocketApp = window.PocketApp || {};
window.PocketApp.chain = Object.freeze({
  openArtistDrawScreen, openArtistChainWorkbench, currentArtistChain,
  copyCurrentArtistChain, refreshArtistChainShortcuts,
});
