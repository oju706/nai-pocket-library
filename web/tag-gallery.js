'use strict';

const tagGallerySites = Object.freeze([
  { id: 'danbooru', label: 'Danbooru' },
  { id: 'gelbooru', label: 'Gelbooru' },
]);
const tagGalleryRatings = Object.freeze([
  ['general', '一般'],
  ['sensitive', '敏感'],
  ['questionable', '疑似成人'],
  ['explicit', '成人'],
  ['all', '全部'],
]);
const tagGallerySorts = Object.freeze([
  ['newest', '最新'],
  ['popular', '热门'],
]);

let activeTagGallery = null;

function tagGallerySite(id) {
  return tagGallerySites.find((site) => site.id === id) || tagGallerySites[0];
}

function tagGalleryNormalizeQuery(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function tagGalleryLastTag(value) {
  return String(value ?? '').normalize('NFKC').match(/[^\s]+$/)?.[0] || '';
}

function tagGalleryReplaceLastTag(value, tag) {
  const query = String(value ?? '').normalize('NFKC');
  const current = tagGalleryLastTag(query);
  const prefix = current.match(/^[-~]/)?.[0] || '';
  return `${query.slice(0, query.length - current.length)}${prefix}${tag}`.trim();
}

function tagGalleryImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin && /^\/tag-gallery-image\/[a-f0-9-]{36}$/.test(url.pathname)
      ? url.href : '';
  } catch {
    return '';
  }
}

function tagGalleryInitials(value) {
  const text = String(value || '图').trim();
  return text.slice(0, 1).toUpperCase();
}

function tagGalleryPostTitle(post, site) {
  const title = typeof post?.title === 'string' ? post.title.trim() : '';
  return title || `${site.label} #${post?.id ?? ''}`;
}

function tagGalleryRatingLabel(value) {
  return tagGalleryRatings.find(([key]) => key === value)?.[1] || String(value || '未标注');
}

function tagGalleryDisplayKind(value) {
  if (typeof tagGalleryKindInfo === 'function') return tagGalleryKindInfo(value);
  const raw = String(value ?? '').trim();
  return { key: raw.toLocaleLowerCase() || 'unknown', label: raw || '未分类', section: '' };
}

function tagGalleryRawKind(tag) {
  const candidates = [tag?.category, tag?.type, tag?.tag_type, tag?.kind]
    .map((value) => String(value ?? '').normalize('NFKC').trim()).filter(Boolean);
  const known = candidates.find((value) => tagGalleryDisplayKind(value).section);
  return known || candidates[0] || '';
}

function tagGalleryDictionaryAppend(target, name, gallery) {
  if (gallery.site !== 'danbooru' || typeof window.tagDictionaryAppend !== 'function') return;
  window.tagDictionaryAppend(target, name, () => activeTagGallery === gallery && target.isConnected);
}

function tagGallerySearchTag(gallery, tag) {
  const value = tagGalleryNormalizeQuery(tag?.name || tag);
  if (!value || activeTagGallery !== gallery) return;
  gallery.query = value;
  gallery.suggestions = [];
  gallery.suggestionRevision++;
  tagGallerySearch(gallery, 1);
}

function tagGalleryTagAction(gallery, tag, label, back = null) {
  if (typeof window.searchTagGalleryInLibrary !== 'function') {
    toast('词库联动尚未载入，请重新打开 App。');
    return;
  }
  window.searchTagGalleryInLibrary(tag, back, `返回 ${tagGallerySite(gallery.site).label} 图片`);
  if (label) toast(`正在${label}中查找参考标签`);
}

async function tagGalleryAddArtistToMixer(tag) {
  const name = tagGalleryNormalizeQuery(tag?.name || tag);
  const mixer = window.PocketApp?.chain;
  if (!name) return;
  if (typeof mixer?.addToMixerPool !== 'function') {
    toast('画风工坊尚未载入，请重新打开 App。');
    return;
  }
  try {
    const result = await mixer.addToMixerPool([name], {});
    if (result?.error) {
      toast(result.error);
      return;
    }
    const added = Number(result?.added) || 0;
    const duplicates = Number(result?.duplicates) || 0;
    const invalid = Number(result?.invalid) || 0;
    const parts = [`已加入当前工坊池 ${added} 位`];
    if (duplicates) parts.push(`重复 ${duplicates}`);
    if (invalid) parts.push(`无效 ${invalid}`);
    if (result?.storageError) parts.push('本机保存未完成');
    toast(parts.join('；'));
  } catch (error) {
    toast(error?.message || '加入画风工坊失败，请重试。');
  }
}

async function tagGalleryFetchJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  let payload = null;
  try { payload = await response.json(); } catch { /* Report a stable message below. */ }
  if (!response.ok) {
    const error = new Error(payload?.error
      || (response.status === 401 ? '需要配置图库凭据，或检查凭据是否有效。'
        : response.status === 403 ? '图库拒绝访问，请检查连接与权限配置。'
          : response.status === 429 ? '图库请求过多，请稍后重试。'
            : `图库请求失败（HTTP ${response.status}）。`));
    error.status = response.status;
    error.code = payload?.code || '';
    throw error;
  }
  return payload;
}

async function tagGalleryFetchPosts(gallery, page) {
  const params = new URLSearchParams({
    site: gallery.site,
    query: gallery.query,
    rating: gallery.rating,
    sort: gallery.sort,
    page: String(page),
  });
  return tagGalleryFetchJson(`/api/tag-gallery/posts?${params.toString()}`);
}

async function tagGalleryFetchTags(gallery, query, revision) {
  const params = new URLSearchParams({ site: gallery.site, query });
  const payload = await tagGalleryFetchJson(`/api/tag-gallery/tags?${params.toString()}`);
  if (activeTagGallery !== gallery || gallery.suggestionRevision !== revision) return;
  gallery.suggestions = Array.isArray(payload?.tags) ? payload.tags : [];
  gallery.suggestionsLoading = false;
  gallery.suggestionsError = false;
  tagGalleryRenderSuggestions(gallery);
}

function tagGalleryFailure(error) {
  const status = Number(error?.status);
  const fallback = error?.message || '图库请求失败，请稍后重试。';
  if (status === 401) return `${fallback} 可以配置连接，也可以直接在 App 内打开官网。`;
  return fallback;
}

function tagGalleryNeedsCredentials(error) {
  return !desktopApp && Number(error?.status) === 401;
}

function tagGallerySuggestionsBox() {
  const box = node('div', 'tag-gallery-suggestions');
  box.dataset.tagGallerySuggestions = 'true';
  box.setAttribute('aria-live', 'polite');
  return box;
}

function tagGalleryRenderSuggestions(gallery) {
  const box = body.querySelector('[data-tag-gallery-suggestions]');
  if (!box || activeTagGallery !== gallery) return;
  box.replaceChildren();
  if (gallery.suggestionsLoading) {
    box.hidden = false;
    box.append(node('p', 'tag-gallery-suggestion-note', '正在查找标签…'));
    return;
  }
  if (gallery.suggestionsError) {
    box.hidden = false;
    box.append(node('p', 'tag-gallery-suggestion-note', '标签建议暂时不可用，仍可直接搜索。'));
    return;
  }
  if (!gallery.suggestions.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const suggestion of gallery.suggestions.slice(0, 10)) {
    const name = String(suggestion?.name || '').trim();
    if (!name) continue;
    const detail = [suggestion.kind, Number.isFinite(Number(suggestion.count))
      ? `${number.format(Number(suggestion.count))} 帖` : ''].filter(Boolean).join(' · ');
    const item = button('', 'tag-gallery-suggestion', () => {
      const input = body.querySelector('[data-tag-gallery-query]');
      if (!input || activeTagGallery !== gallery) return;
      input.value = tagGalleryReplaceLastTag(input.value, name);
      gallery.query = tagGalleryNormalizeQuery(input.value);
      gallery.suggestions = [];
      tagGallerySearch(gallery, 1);
    });
    const suggestionName = node('span', 'tag-gallery-suggestion-name', name);
    tagGalleryDictionaryAppend(suggestionName, name, gallery);
    item.append(suggestionName);
    if (detail) item.append(node('span', 'tag-gallery-suggestion-meta', detail));
    box.append(item);
  }
}

function tagGalleryScheduleSuggestions(gallery, input) {
  clearTimeout(gallery.suggestionTimer);
  gallery.suggestionRevision++;
  const revision = gallery.suggestionRevision;
  const query = tagGalleryLastTag(input.value);
  gallery.suggestions = [];
  gallery.suggestionsLoading = false;
  gallery.suggestionsError = false;
  if (query.replace(/^[-~]/, '').length < 2) {
    tagGalleryRenderSuggestions(gallery);
    return;
  }
  gallery.suggestionsLoading = true;
  tagGalleryRenderSuggestions(gallery);
  gallery.suggestionTimer = setTimeout(() => {
    if (activeTagGallery !== gallery || !input.isConnected) return;
    tagGalleryFetchTags(gallery, query, revision).catch(() => {
      if (activeTagGallery !== gallery || gallery.suggestionRevision !== revision) return;
      gallery.suggestionsLoading = false;
      gallery.suggestionsError = true;
      tagGalleryRenderSuggestions(gallery);
    });
  }, 350);
}

function tagGalleryTile(gallery, post, index) {
  const site = tagGallerySite(gallery.site);
  const title = tagGalleryPostTitle(post, site);
  const tile = button('', 'tag-gallery-tile', () => {
    gallery.scroll = body.scrollTop;
    tagGalleryShowPost(gallery, index);
  });
  tile.setAttribute('aria-label', `预览：${title}`);

  const frame = node('span', 'tag-gallery-tile-frame');
  const placeholder = node('span', 'tag-gallery-tile-placeholder', tagGalleryInitials(title));
  const imageUrl = tagGalleryImageUrl(post.thumbnail);
  if (imageUrl) {
    const image = node('img', 'tag-gallery-tile-image');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.classList.add('is-loading');
    image.addEventListener('load', () => {
      image.classList.remove('is-loading');
      image.classList.add('is-loaded');
      placeholder.hidden = true;
    });
    image.addEventListener('error', () => {
      image.classList.remove('is-loading', 'is-loaded');
      placeholder.hidden = false;
      placeholder.textContent = '预览失败';
    });
    image.src = imageUrl;
    frame.append(image);
  }
  frame.append(placeholder);

  const rating = tagGalleryRatingLabel(post.rating);
  const score = Number(post.score);
  const meta = node('span', 'tag-gallery-tile-meta');
  meta.append(
    node('span', 'tag-gallery-rating', rating),
    node('span', '', Number.isFinite(score) ? `分数 ${number.format(score)}` : site.label),
  );
  const caption = node('span', 'tag-gallery-tile-caption');
  caption.append(node('span', 'tag-gallery-tile-title', title), meta);
  tile.append(frame, caption);
  return tile;
}

function tagGalleryPagination(gallery) {
  const nav = node('nav', 'tag-gallery-pagination');
  nav.setAttribute('aria-label', '图库分页');
  const previous = button('上一页', 'soft', () => tagGallerySearch(gallery, gallery.page - 1));
  const next = button('下一页', 'soft', () => tagGallerySearch(gallery, gallery.page + 1));
  previous.disabled = gallery.page <= 1;
  next.disabled = !gallery.hasNext;

  const jump = node('form', 'tag-gallery-page-jump');
  const input = node('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = String(gallery.page);
  input.setAttribute('aria-label', '跳转图库页码');
  const submit = node('button', 'soft compact', '跳转');
  submit.type = 'submit';
  jump.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.normalize('NFKC').trim();
    const page = Number(value);
    if (!/^\d{1,4}$/.test(value) || page < 1 || page > 1000) {
      toast('请输入 1 到 1000 之间的整数页码。');
      input.focus();
      return;
    }
    if (page !== gallery.page) tagGallerySearch(gallery, page);
  });
  jump.append(input, submit);
  nav.append(previous, node('span', 'tag-gallery-page-status', `第 ${gallery.page} 页`), next, jump);
  return nav;
}

function tagGalleryPrimeThumbnailRows(grid) {
  if (!grid?.isConnected || typeof grid.querySelectorAll !== 'function') return;
  const template = typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle(grid).gridTemplateColumns.trim() : '';
  const compact = typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 680px)').matches;
  const columns = template && template !== 'none'
    ? template.split(/\s+/).filter(Boolean).length
    : (compact ? 2 : 1);
  const eagerCount = Math.max(1, columns) * 2;
  [...grid.querySelectorAll('img.tag-gallery-tile-image')].forEach((image, index) => {
    if (index < eagerCount) {
      image.loading = 'eager';
      image.fetchPriority = 'high';
    } else {
      image.loading = 'lazy';
    }
  });
}

function tagGalleryResultView(gallery) {
  if (gallery.loading) {
    const loading = node('section', 'tag-gallery-state');
    loading.append(
      node('span', 'tag-gallery-spinner'),
      node('h2', '', `正在查找 ${tagGallerySite(gallery.site).label} 图片…`),
    );
    loading.setAttribute('role', 'status');
    return loading;
  }
  if (gallery.error) {
    const failure = node('section', 'tag-gallery-state tag-gallery-state-error');
    failure.append(
      node('h2', '', gallery.error.status === 429 ? '请求太频繁' : '图库读取失败'),
      node('p', '', tagGalleryFailure(gallery.error)),
    );
    if (tagGalleryNeedsCredentials(gallery.error)) {
      const websiteHint = node('div', 'tag-gallery-state-hint');
      websiteHint.setAttribute('role', 'note');
      websiteHint.append(
        node('strong', '', gallery.site === 'gelbooru'
          ? 'Gelbooru 可能需要用户 ID 和 API Key。'
          : '当前请求需要有效连接。'),
        node('span', '', '可点击上方「在 App 内打开官网」继续浏览，或在这里检查连接设置。'),
      );
      failure.append(websiteHint);
    }
    const controls = node('div', 'tag-gallery-state-actions');
    controls.append(button('重试', 'soft', () => tagGallerySearch(gallery, gallery.page)));
    if (tagGalleryNeedsCredentials(gallery.error)) {
      controls.append(button('连接设置', 'primary', () => tagGalleryOpenCredentials(gallery)));
    }
    failure.append(controls);
    return failure;
  }
  if (!gallery.loaded) {
    const start = node('section', 'tag-gallery-state tag-gallery-state-start');
    start.append(
      node('h2', '', '按标签找图'),
      node('p', '', '输入部分名称后可以点选候选标签。留空搜索可浏览当前分级的帖子。'),
    );
    return start;
  }
  const results = node('section', 'tag-gallery-results');
  if (!gallery.items.length) {
    results.append(node('p', 'empty', gallery.hasNext ? '这一页没有可预览的图片，可以继续下一页。' : '这一页没有找到图片。'));
    if (gallery.page > 1 || gallery.hasNext) results.append(tagGalleryPagination(gallery));
    return results;
  }
  const heading = node('div', 'tag-gallery-results-heading');
  heading.append(
    node('h2', '', `${tagGallerySite(gallery.site).label} · ${gallery.query || '全部帖子'}`),
    node('p', '', [
      gallery.total != null ? `约 ${number.format(Number(gallery.total) || 0)} 条` : '',
      `第 ${gallery.page} 页`,
      gallery.rating === 'all' ? '全部分级' : tagGalleryRatingLabel(gallery.rating),
      gallery.sort === 'popular' ? '按热门' : '按最新',
    ].filter(Boolean).join(' · ')),
  );
  const grid = node('div', 'tag-gallery-grid');
  gallery.items.forEach((post, index) => grid.append(tagGalleryTile(gallery, post, index)));
  results.append(heading, grid, tagGalleryPagination(gallery));
  return results;
}

function tagGalleryRenderResult(gallery) {
  const container = body.querySelector('[data-tag-gallery-results]');
  if (!container || activeTagGallery !== gallery) return;
  container.replaceChildren(tagGalleryResultView(gallery));
  tagGalleryPrimeThumbnailRows(container.querySelector('.tag-gallery-grid'));
}

function tagGalleryOpenCredentials(gallery) {
  gallery.scroll = body.scrollTop;
  gallery.postRevision++;
  gallery.suggestionRevision++;
  gallery.loading = false;
  gallery.suggestionsLoading = false;
  showTagGalleryCredentials(() => tagGalleryRenderSearch(gallery, gallery.scroll));
}

function tagGalleryRenderSearch(gallery, requestedScroll = 0) {
  activeTagGallery = gallery;
  const site = tagGallerySite(gallery.site);
  openScreen(`${site.label} 图库`, gallery.back, true);
  const root = node('section', 'tag-gallery-screen');
  const sources = node('div', 'tag-gallery-sources');
  sources.setAttribute('role', 'group');
  sources.setAttribute('aria-label', '图库来源');
  for (const source of tagGallerySites) {
    const control = button(source.label, 'chip', () => {
      const input = body.querySelector('[data-tag-gallery-query]');
      gallery.query = tagGalleryNormalizeQuery(input?.value ?? gallery.query);
      if (desktopApp && source.id === 'gelbooru') {
        openTagGalleryWebsite(PocketSources.tagGalleryWebsiteUrl(source.id, gallery.query, gallery.rating, gallery.sort));
        return;
      }
      if (gallery.site === source.id) return;
      gallery.site = source.id;
      gallery.suggestions = [];
      gallery.suggestionRevision++;
      if (gallery.query || gallery.loaded || gallery.loading || gallery.error) tagGallerySearch(gallery, 1);
      else tagGalleryRenderSearch(gallery);
    });
    control.setAttribute('aria-pressed', String(gallery.site === source.id));
    sources.append(control);
  }
  const website = button(desktopApp ? '打开官网' : '在 App 内打开官网', 'soft tag-gallery-website-open', () => {
    const input = body.querySelector('[data-tag-gallery-query]');
    openTagGalleryWebsite(PocketSources.tagGalleryWebsiteUrl(
      gallery.site,
      input?.value ?? gallery.query,
      gallery.rating,
      gallery.sort,
    ));
  });
  website.dataset.tagGalleryWebsite = 'true';
  website.title = `在 App 内打开 ${site.label} 官网`;
  const sourceRow = node('div', 'tag-gallery-source-row');
  sourceRow.append(sources, website);

  const form = node('form', 'tag-gallery-search-form');
  const query = textInput('input', gallery.query, '例如 hatsune_miku*', 512);
  query.type = 'search';
  query.dataset.tagGalleryQuery = 'true';
  query.autocapitalize = 'none';
  query.autocomplete = 'off';
  query.spellcheck = false;
  query.setAttribute('aria-label', '图库标签，多个标签用空格分隔');
  const submit = node('button', 'primary', '搜索图库');
  submit.type = 'submit';
  const fieldBox = node('div', 'tag-gallery-query-box');
  fieldBox.append(field('标签', query), submit);
  form.append(fieldBox, tagGallerySuggestionsBox());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    gallery.query = tagGalleryNormalizeQuery(query.value);
    gallery.suggestions = [];
    gallery.suggestionRevision++;
    tagGallerySearch(gallery, 1);
  });
  const changedQuery = () => {
    gallery.query = tagGalleryNormalizeQuery(query.value);
    gallery.postRevision++;
    gallery.loaded = false;
    gallery.loading = false;
    gallery.error = null;
    gallery.items = [];
    gallery.page = 1;
    gallery.hasNext = false;
    tagGalleryRenderResult(gallery);
    tagGalleryScheduleSuggestions(gallery, query);
  };
  query.addEventListener('input', (event) => { if (!event.isComposing) changedQuery(); });
  query.addEventListener('compositionend', changedQuery);

  const filters = node('div', 'tag-gallery-filters');
  const rating = options(tagGalleryRatings, gallery.rating);
  rating.addEventListener('change', () => {
    gallery.query = tagGalleryNormalizeQuery(query.value);
    gallery.rating = rating.value;
    tagGallerySearch(gallery, 1);
  });
  const sort = options(tagGallerySorts, gallery.sort);
  sort.addEventListener('change', () => {
    gallery.query = tagGalleryNormalizeQuery(query.value);
    gallery.sort = sort.value;
    tagGallerySearch(gallery, 1);
  });
  filters.append(field('分级', rating), field('排序', sort));

  const result = node('div', 'tag-gallery-result');
  result.dataset.tagGalleryResults = 'true';
  result.append(tagGalleryResultView(gallery));
  root.append(sourceRow, form, node('p', 'tag-gallery-query-hint', '多个标签用空格分隔，可用 * 模糊匹配。'), filters, result);
  body.append(root);
  tagGalleryPrimeThumbnailRows(result.querySelector('.tag-gallery-grid'));
  body.scrollTop = requestedScroll;
  tagGalleryRenderSuggestions(gallery);

  actions.replaceChildren(
    button('连接设置', 'soft', () => tagGalleryOpenCredentials(gallery)),
    button('中文词典', 'soft', () => {
      if (typeof window.showTagDictionarySettings !== 'function') {
        toast('中文词典入口尚未载入，请重新打开 App。');
        return;
      }
      const scroll = body.scrollTop;
      window.showTagDictionarySettings(() => tagGalleryRenderSearch(gallery, scroll));
    }),
  );
}

async function tagGallerySearch(gallery, requestedPage = 1) {
  if (activeTagGallery !== gallery) return;
  const page = Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1);
  const revision = ++gallery.postRevision;
  gallery.page = page;
  gallery.items = [];
  gallery.hasNext = false;
  gallery.total = null;
  gallery.loaded = false;
  gallery.loading = true;
  gallery.error = null;
  gallery.suggestions = [];
  gallery.suggestionsLoading = false;
  gallery.suggestionsError = false;
  gallery.suggestionRevision++;
  clearTimeout(gallery.suggestionTimer);
  tagGalleryRenderSearch(gallery, 0);
  const screenAtRequest = screenRevision;
  try {
    const payload = await tagGalleryFetchPosts(gallery, page);
    if (activeTagGallery !== gallery || gallery.postRevision !== revision || screenRevision !== screenAtRequest) return;
    if (!Array.isArray(payload?.items)) throw new Error('图库返回的数据格式不正确。');
    gallery.items = payload.items;
    gallery.hasNext = payload.hasNext === true;
    gallery.total = Number.isSafeInteger(payload.total) && payload.total >= 0 ? payload.total : null;
    gallery.loaded = true;
  } catch (error) {
    if (activeTagGallery !== gallery || gallery.postRevision !== revision || screenRevision !== screenAtRequest) return;
    gallery.error = error;
  } finally {
    if (activeTagGallery === gallery && gallery.postRevision === revision && screenRevision === screenAtRequest) {
      gallery.loading = false;
      tagGalleryRenderSearch(gallery, 0);
    }
  }
}

function tagGalleryShowPost(gallery, index, requestedScroll = 0) {
  activeTagGallery = gallery;
  if (!gallery.items[index]) return;
  gallery.detailIndex = index;
  const post = gallery.items[index];
  const site = tagGallerySite(gallery.site);
  const title = tagGalleryPostTitle(post, site);
  const back = () => tagGalleryRenderSearch(gallery, gallery.scroll || 0);
  openScreen('图库预览', back, true);

  const root = node('section', 'tag-gallery-detail');
  const stage = node('div', 'tag-gallery-detail-stage');
  const imageUrl = tagGalleryImageUrl(post.preview || post.thumbnail);
  if (imageUrl) {
    const image = node('img', 'tag-gallery-detail-image');
    image.alt = title;
    image.decoding = 'async';
    const status = node('div', 'tag-gallery-image-status', '正在读取预览…');
    stage.append(status);
    image.hidden = true;
    image.addEventListener('load', () => {
      status.remove();
      image.hidden = false;
    });
    image.addEventListener('error', () => {
      const thumbnail = tagGalleryImageUrl(post.thumbnail);
      if (thumbnail && image.src !== thumbnail) {
        image.src = thumbnail;
        status.textContent = '大图读取失败，正在显示缩略图…';
        return;
      }
      status.textContent = '预览图读取失败，可尝试打开原帖。';
    });
    image.src = imageUrl;
    stage.append(image);
  } else {
    stage.append(node('div', 'tag-gallery-image-status', '这张帖子没有可用的同源预览。'));
  }

  const info = node('aside', 'tag-gallery-detail-info');
  info.append(node('p', 'tag-gallery-eyebrow', site.label), node('h2', '', title));
  const score = Number(post.score);
  const dimensions = Number(post.width) > 0 && Number(post.height) > 0
    ? `${post.width} × ${post.height}` : '';
  info.append(node('p', 'tag-gallery-detail-meta', [
    tagGalleryRatingLabel(post.rating),
    Number.isFinite(score) ? `分数 ${number.format(score)}` : '',
    dimensions,
  ].filter(Boolean).join(' · ')));

  const tags = Array.isArray(post.tags)
    ? post.tags.map((tag) => (typeof tag === 'string'
      ? { name: tag, kind: '' }
      : { ...tag, kind: tagGalleryRawKind(tag) }))
      .filter((tag) => tag && typeof tag.name === 'string' && tag.name.trim())
    : [];
  if (tags.length) {
    info.append(node('h3', 'tag-gallery-detail-heading', '标签与联动'));
    const grouped = new Map();
    for (const tag of tags) {
      const kind = tagGalleryDisplayKind(tag.kind);
      if (!grouped.has(kind.key)) grouped.set(kind.key, { kind, tags: [] });
      grouped.get(kind.key).tags.push(tag);
    }
    const groupOrder = ['artist', 'copyright', 'character', 'general', 'meta'];
    const groups = [...grouped.values()].sort((a, b) => {
      const ai = groupOrder.indexOf(a.kind.key);
      const bi = groupOrder.indexOf(b.kind.key);
      return (ai < 0 ? groupOrder.length : ai) - (bi < 0 ? groupOrder.length : bi);
    });
    const tagGroups = node('div', 'tag-gallery-tag-groups');
    for (const { kind, tags: groupTags } of groups) {
      const group = node('section', 'tag-gallery-tag-group');
      const heading = node('h4', 'tag-gallery-tag-group-heading');
      heading.append(node('span', '', kind.label), node('small', '', `${groupTags.length} 个`));
      const rows = node('div', 'tag-gallery-tag-rows');
      for (const tag of groupTags) {
        const row = node('div', 'tag-gallery-tag-row');
        const name = node('div', 'tag-gallery-tag-name');
        name.append(node('strong', '', tag.name),
          node('span', 'tag-gallery-tag-category', kind.label));
        tagGalleryDictionaryAppend(name, tag.name, gallery);
        const controls = node('div', 'tag-gallery-tag-actions');
        const copyControl = button('复制', 'soft compact', () => copy(tag.name));
        copyControl.setAttribute('aria-label', `复制标签 ${tag.name}`);
        controls.append(copyControl);
        if (gallery.site === 'danbooru' && kind.section === 'artist') {
          const mixerControl = button('入池', 'soft compact tag-gallery-mixer-add', async () => {
            mixerControl.disabled = true;
            mixerControl.setAttribute('aria-busy', 'true');
            try {
              await tagGalleryAddArtistToMixer(tag);
            } finally {
              if (mixerControl.isConnected) {
                mixerControl.disabled = false;
                mixerControl.removeAttribute('aria-busy');
              }
            }
          });
          mixerControl.setAttribute('aria-label', `将 ${tag.name} 加入画风工坊当前模型池`);
          mixerControl.title = '加入工坊当前模型池';
          controls.append(mixerControl);
        }
        if (gallery.site === 'danbooru' && kind.section) {
          controls.append(tagGalleryFavoriteButton(tag, (scroll) => tagGalleryShowPost(gallery, index, scroll)));
        }
        const menuActions = node('div', 'tag-gallery-tag-menu-actions');
        menuActions.append(button('用它搜图', 'soft compact', () => tagGallerySearchTag(gallery, tag)));
        if (kind.section) {
          menuActions.append(button('在词库搜索', 'soft compact', () => {
            const scroll = body.scrollTop;
            tagGalleryTagAction(gallery, tag, kind.section === 'artist' ? '画师库'
              : kind.section === 'character' ? '角色库' : '画面提示词知识',
              () => tagGalleryShowPost(gallery, index, scroll));
          }));
        }
        if (typeof window.openTagGalleryReferenceTool === 'function') {
          menuActions.append(button('提示词工具', 'soft compact', () => {
            const scroll = body.scrollTop;
            window.openTagGalleryReferenceTool(
              [{ name: tag.name, kind: tag.kind || '' }],
              `${site.label} 原始标签`,
              () => tagGalleryShowPost(gallery, index, scroll),
              gallery.site,
            );
          }));
        }
        if (kind.section === 'artist') {
          menuActions.append(button('加入画风串', 'soft compact', () => {
            const scroll = body.scrollTop;
            openArtistChainWorkbench({
              initialTag: tag.name,
              back: () => tagGalleryShowPost(gallery, index, scroll),
            });
          }));
        }
        if (gallery.site === 'danbooru') {
          menuActions.append(button('打开 Wiki', 'soft compact', () =>
            openTagGalleryWebsite(`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(
              tag.name.normalize('NFKC').trim().replace(/\s+/g, '_'))}`)));
        }
        const menu = node('details', 'tag-gallery-tag-menu');
        menu.append(node('summary', '', '更多'), menuActions);
        controls.append(menu);
        row.append(name, controls);
        rows.append(row);
      }
      group.append(heading, rows);
      tagGroups.append(group);
    }
    info.append(tagGroups,
      button('复制全部标签', 'soft compact', () => copy(tags.map((tag) => tag.name).join(' '))));
  }

  const detailNav = node('div', 'tag-gallery-detail-nav');
  const previous = button('上一张', 'soft', () => tagGalleryShowPost(gallery, index - 1));
  const next = button('下一张', 'soft', () => tagGalleryShowPost(gallery, index + 1));
  previous.disabled = index <= 0;
  next.disabled = index >= gallery.items.length - 1;
  detailNav.append(previous, node('span', '', `${index + 1} / ${gallery.items.length}`), next);
  info.append(detailNav);
  root.append(stage, info);
  body.append(root);

  actions.replaceChildren(button('返回图库', 'primary', back));
  if (typeof post.postUrl === 'string' && post.postUrl.startsWith('https://')) {
    actions.append(button('打开原帖', 'soft', () => openTagGalleryWebsite(post.postUrl)));
  }
  body.scrollTop = requestedScroll;
}

function tagGalleryBrowserFallback(initialTag, back, initialSite) {
  const site = tagGallerySite(initialSite);
  openScreen(`${site.label} 外站搜索`, back, true);
  const root = node('section', 'tag-gallery-browser-fallback');
  root.append(
    node('p', 'tag-gallery-eyebrow', '浏览器预览'),
    node('h2', 'tag-gallery-title', '在浏览器中查看图库'),
    node('p', 'tag-gallery-intro-note', 'Android App 内可直接浏览图库；当前环境没有安卓桥，因此会使用外站搜索页面。'),
  );
  const input = textInput('input', tagGalleryNormalizeQuery(initialTag), '输入画师、角色或多个标签', 512);
  input.type = 'search';
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const controls = node('div', 'tag-gallery-browser-actions');
  for (const source of tagGallerySites) {
    controls.append(button(`打开 ${source.label}`, 'soft', () => {
      openLink(PocketSources.tagGalleryWebsiteUrl(source.id, input.value));
    }));
  }
  const form = node('form', 'tag-gallery-search-form');
  const submit = node('button', 'primary', '打开外站搜索');
  submit.type = 'submit';
  form.append(field('标签', input), submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    openLink(PocketSources.tagGalleryWebsiteUrl(site.id, input.value));
  });
  root.append(form, controls);
  body.append(root);
  actions.replaceChildren(button('关闭', 'text-button', () => {
    if (back) back();
    else closeScreen();
  }));
}

function showInAppTagGallery(initialTag = '', back = null, initialSite = 'danbooru') {
  if (!window.Pocket && (!desktopApp || initialSite === 'gelbooru')) {
    tagGalleryBrowserFallback(initialTag, back, initialSite);
    return;
  }
  const gallery = {
    back,
    site: tagGallerySite(initialSite).id,
    query: tagGalleryNormalizeQuery(initialTag),
    rating: 'general',
    sort: 'newest',
    page: 1,
    loaded: false,
    loading: false,
    error: null,
    items: [],
    hasNext: false,
    total: null,
    suggestions: [],
    suggestionsLoading: false,
    suggestionsError: false,
    suggestionRevision: 0,
    postRevision: 0,
    scroll: 0,
  };
  activeTagGallery = gallery;
  if (gallery.query) tagGallerySearch(gallery, 1);
  else tagGalleryRenderSearch(gallery);
}

function tagGalleryCredentialSection(site, screenAtOpen) {
  const section = toolSection(`${site.label} 连接`,
    site.id === 'gelbooru'
      ? 'Gelbooru 通常需要用户 ID 和 API Key。凭据仅交给安卓原生存储，不写入网页持久存储。'
      : 'Danbooru 凭据可选。部分受限内容或较高频率请求可能需要登录。凭据仅交给安卓原生存储。');
  const account = textInput('input', '', site.id === 'gelbooru' ? 'Gelbooru 用户 ID' : 'Danbooru 登录名', 256);
  account.autocomplete = 'username';
  account.spellcheck = false;
  const key = textInput('input', '', site.id === 'gelbooru' ? 'Gelbooru API Key' : 'Danbooru API Key', 512);
  key.type = 'password';
  key.autocomplete = 'off';
  key.spellcheck = false;
  const status = node('p', 'tag-gallery-credential-status', '正在读取连接状态…');
  status.setAttribute('aria-live', 'polite');
  const controls = node('div', 'tool-actions');
  const save = button('保存连接', 'primary', async () => {
    save.disabled = clear.disabled = true;
    status.textContent = '正在保存…';
    try {
      await native('saveTagGalleryCredentials', JSON.stringify({
        site: site.id,
        account: account.value.trim(),
        key: key.value.trim(),
      }));
      if (screenAtOpen !== screenRevision) return;
      account.value = '';
      key.value = '';
      status.textContent = '已保存到此设备。';
      toast(`${site.label} 连接已保存`);
    } catch (error) {
      if (screenAtOpen !== screenRevision) return;
      status.textContent = error?.message || '保存失败，请稍后重试。';
    } finally {
      if (screenAtOpen === screenRevision) save.disabled = clear.disabled = false;
    }
  });
  const clear = button('清除连接', 'soft', async () => {
    save.disabled = clear.disabled = true;
    status.textContent = '正在清除…';
    try {
      await native('saveTagGalleryCredentials', JSON.stringify({ site: site.id, account: '', key: '' }));
      if (screenAtOpen !== screenRevision) return;
      account.value = '';
      key.value = '';
      status.textContent = '尚未配置凭据。';
      toast(`${site.label} 连接已清除`);
    } catch (error) {
      if (screenAtOpen !== screenRevision) return;
      status.textContent = error?.message || '清除失败，请稍后重试。';
    } finally {
      if (screenAtOpen === screenRevision) save.disabled = clear.disabled = false;
    }
  });
  controls.append(save, clear);
  section.append(field('用户 ID / 登录名', account), field('API Key', key), controls, status);

  native('tagGalleryCredentialStatus', site.id).then((value) => {
    if (screenAtOpen !== screenRevision) return;
    status.textContent = value?.configured ? '已配置凭据。' : '尚未配置凭据。';
  }).catch((error) => {
    if (screenAtOpen !== screenRevision) return;
    status.textContent = error?.message || '暂时无法读取连接状态。';
  });
  return section;
}

function showTagGalleryCredentials(back = null) {
  if (!window.Pocket) {
    openScreen('图库连接设置', back, true);
    toolSection('仅限 Android App',
      '图库凭据由安卓原生存储管理。浏览器预览不会保存 API Key，请在 App 中配置。');
    actions.replaceChildren(button('关闭', 'text-button', () => {
      if (back) back();
      else closeScreen();
    }));
    return;
  }
  openScreen('图库连接设置', back, true);
  const screenAtOpen = screenRevision;
  toolSection('图库接口', 'Gelbooru 需要用户 ID 和 API Key，Danbooru 可选。凭据加密存放在本机，只发给对应网站。');
  for (const site of tagGallerySites) tagGalleryCredentialSection(site, screenAtOpen);
  actions.replaceChildren(button('关闭', 'text-button', () => {
    if (back) back();
    else closeScreen();
  }));
}

window.showInAppTagGallery = showInAppTagGallery;
window.showTagGalleryCredentials = showTagGalleryCredentials;
