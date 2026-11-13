'use strict';

const galleryPageSize = 24;
const galleryDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
let gallerySession = 0;
let galleryPage = 0;
let galleryScroll = 0;

function galleryDateValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      return numeric < 100000000000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function galleryFormatDate(value) {
  const timestamp = galleryDateValue(value);
  if (!timestamp) return '保存时间未知';
  try {
    return galleryDateFormatter.format(new Date(timestamp));
  } catch {
    return '保存时间未知';
  }
}

function galleryFormatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function galleryItemName(item) {
  return item && typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名原图';
}

function galleryItemAlt(item) {
  const format = item && typeof item.format === 'string' ? item.format : '图片';
  return `${galleryItemName(item)}，${format}，${galleryFormatDate(item && item.createdAt)}`;
}

function galleryImageUrl(item, thumbnail) {
  const id = encodeURIComponent(String(item.id));
  return `/gallery-image/${id}${thumbnail ? '?thumb=1' : ''}`;
}

function galleryThumbnail(item, session) {
  const tile = button('', 'nai-gallery-tile', () => {
    if (session !== gallerySession) return;
    galleryScroll = body.scrollTop;
    showGalleryDetail(item);
  });
  tile.setAttribute('aria-label', `查看原图：${galleryItemAlt(item)}`);

  const frame = node('span', 'nai-gallery-thumb-frame');
  const status = node('span', 'nai-gallery-thumb-status', '正在读取缩略图…');
  const image = node('img', 'nai-gallery-thumb-image');
  image.alt = galleryItemAlt(item);
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => {
    image.hidden = false;
    status.hidden = true;
  });
  image.addEventListener('error', () => {
    image.hidden = true;
    status.hidden = false;
    status.textContent = '缩略图读取失败\n点按查看原图';
  });
  image.src = galleryImageUrl(item, true);
  frame.append(image, status);

  const format = typeof item.format === 'string' && item.format ? item.format : '图片';
  const size = galleryFormatBytes(item.bytes);
  const caption = node('span', 'nai-gallery-tile-caption');
  caption.append(
    node('span', 'nai-gallery-tile-name', galleryItemName(item)),
    node('span', 'nai-gallery-tile-meta', [format, size, galleryFormatDate(item.createdAt)].filter(Boolean).join(' · ')),
  );
  tile.append(frame, caption);
  return tile;
}

function galleryEmptyState() {
  const empty = node('div', 'nai-gallery-empty');
  empty.append(
    node('h2', '', '还没有保存原图'),
    node('p', '', '导入后，本机图库会保留小预览。查看过的生成信息也可在本机保存。'),
  );
  return empty;
}

async function galleryImport(session, trigger) {
  if (session !== gallerySession) return;
  const revision = screenRevision;
  trigger.disabled = true;
  trigger.textContent = '正在导入…';
  try {
    const result = await native('importGallery');
    if (session !== gallerySession || revision !== screenRevision) return;
    if (!result) {
      trigger.disabled = false;
      trigger.textContent = '导入原图';
      return;
    }
    const added = Number.isFinite(Number(result.added)) ? Number(result.added) : 0;
    const skipped = Number.isFinite(Number(result.skipped)) ? Number(result.skipped) : 0;
    showGallery(0);
    if (added || skipped) {
      toast(result.message || `已导入 ${added} 张原图${skipped ? `，跳过 ${skipped} 张` : ''}`);
    } else {
      toast('没有新增原图');
    }
  } catch (error) {
    if (session !== gallerySession || revision !== screenRevision) return;
    trigger.disabled = false;
    trigger.textContent = '导入原图';
    toast(error && error.message ? error.message : '导入原图失败。');
  }
}

function galleryListActions(session) {
  const trigger = button('导入原图', 'primary', () => galleryImport(session, trigger));
  actions.replaceChildren(button('外站找图', 'soft', () => {
    const page = galleryPage;
    const scroll = body.scrollTop;
    showTagGalleries('', () => showGallery(page, scroll));
  }), trigger);
}

async function galleryLoad(session, requestedPage, requestedScroll) {
  openScreen('原图图库');
  const revision = screenRevision;
  galleryListActions(session);

  const loading = node('div', 'nai-gallery-loading', '正在读取本地图库…');
  loading.setAttribute('role', 'status');
  body.append(loading);

  try {
    const listed = await native('listGallery', String(requestedPage));
    if (session !== gallerySession || revision !== screenRevision) return;
    if (!Array.isArray(listed?.items)) throw new Error('图库数据格式不正确。');
    const { items, total, bytes, page, pages } = listed;

    body.replaceChildren();
    const heading = node('section', 'nai-gallery-heading');
    heading.append(
      node('p', 'nai-gallery-eyebrow', '仅保存在此设备'),
      node('h2', '', `本地图库 · ${total} 张`),
      node('p', 'nai-gallery-note', `图片与生成信息占用 ${galleryFormatBytes(bytes)}`),
      node('p', 'nai-gallery-note', '新导入的图片只保存小预览。已经读取并保存的生成信息可离线查看。'),
    );
    body.append(heading);

    if (!items.length) {
      galleryPage = 0;
      galleryScroll = 0;
      body.append(galleryEmptyState());
      return;
    }

    const grid = node('div', 'nai-gallery-grid');
    galleryPage = page;
    galleryScroll = page === requestedPage ? requestedScroll : 0;
    function move(target) {
      if (session === gallerySession && revision === screenRevision && target !== page) {
        galleryLoad(session, target, 0);
      }
    }
    if (pages > 1) body.append(pageJump(page, pages, move));
    grid.append(...items.map(item => galleryThumbnail(item, session)));
    body.append(grid);
    if (pages > 1) {
      const start = page * galleryPageSize;
      const footer = node('div', 'nai-gallery-footer');
      footer.append(node('span', 'nai-gallery-count', `第 ${start + 1}–${start + items.length} 张，共 ${total} 张`),
        pageSteps(page, pages, move));
      body.append(footer);
    }
    body.scrollTop = galleryScroll;
  } catch (error) {
    if (session !== gallerySession || revision !== screenRevision) return;
    body.replaceChildren();
    const failure = node('div', 'nai-gallery-empty nai-gallery-failure');
    failure.append(
      node('h2', '', '图库读取失败'),
      node('p', '', error && error.message ? error.message : '请稍后重试。'),
    );
    const retry = button('重新读取', 'primary', () => {
      if (session === gallerySession) galleryLoad(session, galleryPage, galleryScroll);
    });
    failure.append(retry);
    body.append(failure);
    actions.replaceChildren(button('关闭', 'soft', () => {
      if (session === gallerySession) {
        closeScreen();
      }
    }));
  }
}

function showGallery(page = 0, scroll = 0) {
  const session = ++gallerySession;
  galleryPage = Number.isInteger(page) ? page : 0;
  galleryScroll = scroll;
  galleryLoad(session, galleryPage, galleryScroll);
}

function galleryDetailImage(item) {
  const stage = node('div', 'nai-gallery-image-stage');
  const frame = node('div', 'nai-gallery-image-frame');
  const controls = node('div', 'nai-gallery-image-controls');
  stage.append(frame, controls);

  const previewEntry = item.kind === 'preview';
  let showOriginal = !previewEntry;
  let naturalSize = false;
  const originalToggle = button('打开手机原图', 'nai-gallery-size-toggle', () => {
    showOriginal = !showOriginal;
    loadImage();
  });
  const sizeToggle = button('原始尺寸', 'nai-gallery-size-toggle', () => {
    naturalSize = !naturalSize;
    frame.classList.toggle('nai-gallery-is-natural', naturalSize);
    sizeToggle.textContent = naturalSize ? '适应屏幕' : '原始尺寸';
    sizeToggle.setAttribute('aria-pressed', String(naturalSize));
  });
  sizeToggle.setAttribute('aria-pressed', 'false');
  if (previewEntry && item.sourceLinked) controls.append(originalToggle);
  controls.append(sizeToggle);

  function loadImage() {
    const original = showOriginal;
    naturalSize = false;
    frame.classList.remove('nai-gallery-is-natural');
    sizeToggle.hidden = !original;
    sizeToggle.textContent = '原始尺寸';
    sizeToggle.setAttribute('aria-pressed', 'false');
    originalToggle.textContent = original ? '返回小预览' : '打开手机原图';
    const loading = node('div', 'nai-gallery-image-status', original ? '正在读取完整原图…' : '正在读取小预览…');
    loading.setAttribute('role', 'status');
    const image = node('img', 'nai-gallery-full-image');
    image.alt = `${original ? '完整原图' : '小预览'}：${galleryItemAlt(item)}`;
    image.decoding = 'async';
    image.hidden = true;
    image.addEventListener('load', () => {
      image.hidden = false;
      loading.remove();
    });
    image.addEventListener('error', () => {
      if (image.parentNode !== frame) return;
      if (original && previewEntry) {
        showOriginal = false;
        toast('手机原图已无法读取，已切回小预览。');
        loadImage();
        return;
      }
      const failure = node('div', 'nai-gallery-image-status nai-gallery-image-error');
      failure.append(node('span', '', '图片读取失败。'), button('重试', 'soft', loadImage));
      frame.replaceChildren(failure);
    });
    frame.replaceChildren(loading, image);
    image.src = galleryImageUrl(item, !original);
  }
  loadImage();
  return stage;
}

function showGalleryDetail(item) {
  const session = ++gallerySession;
  const returnToGallery = () => showGallery(galleryPage, galleryScroll);
  openScreen('原图详情', returnToGallery, true);
  const revision = screenRevision;
  const active = () => session === gallerySession && revision === screenRevision;

  const date = galleryFormatDate(item.createdAt);
  const type = item.kind === 'preview' ? '小预览' : '旧版完整副本';
  const facts = [type, item.format, galleryFormatBytes(item.bytes), date].filter(Boolean).join(' · ');
  const heading = node('section', 'nai-gallery-detail-heading');
  heading.append(
    node('h2', '', galleryItemName(item)),
    node('p', 'nai-gallery-note', facts),
  );
  const layout = node('div', 'nai-gallery-detail-layout');
  const info = node('div', 'nai-gallery-detail-info');
  info.append(heading);
  layout.append(galleryDetailImage(item), info);
  body.append(layout);

  const metadataButton = button('查看提示词 / 参数', 'primary', async () => {
    if (!active()) return;
    metadataButton.disabled = true;
    metadataButton.textContent = '正在读取…';
    try {
      const summary = await native('galleryMetadata', item.id);
      if (!active()) return;
      if (!summary) {
        toast('这张原图没有可读取的生成信息。');
        metadataButton.disabled = false;
        metadataButton.textContent = '查看提示词 / 参数';
        return;
      }
      showPromptImport(summary, {
        back: () => showGalleryDetail(item),
        galleryItem: item,
      });
    } catch (error) {
      if (!active()) return;
      metadataButton.disabled = false;
      metadataButton.textContent = '查看提示词 / 参数';
      toast(error && error.message ? error.message : '读取生成信息失败。');
    }
  });

  const remove = button('从图库删除', 'subtle danger compact', async () => {
    if (!active()) return;
    const message = item.kind === 'preview'
      ? '删除此条目的小预览和已保存的生成信息？手机原文件会保留。'
      : '删除 App 内的完整副本和已保存的生成信息？手机原文件会保留。';
    if (!confirm(message)) return;
    remove.disabled = true;
    metadataButton.disabled = true;
    exportButton.disabled = true;
    try {
      const deleted = await native('deleteGalleryImage', item.id);
      if (!active()) return;
      returnToGallery();
      toast(deleted ? '已从图库删除' : '此条目已不存在');
    } catch (error) {
      if (!active()) return;
      toast(error.message || '无法删除，请重试。');
      remove.disabled = false;
      metadataButton.disabled = false;
      exportButton.disabled = false;
    }
  });

  const exportOriginal = button('导出原图', 'soft', async () => {
    if (!active()) return;
    exportOriginal.disabled = exportButton.disabled = metadataButton.disabled = remove.disabled = true;
    try {
      const saved = await native('exportGalleryOriginal', item.id);
      if (active() && saved === true) toast('已导出原图，可在文件应用分享');
    } catch (error) {
      if (active()) toast(error?.message || '原图已无法读取，仍可导出小预览和参数。');
    } finally {
      if (active()) {
        exportOriginal.disabled = exportButton.disabled = metadataButton.disabled = remove.disabled = false;
      }
    }
  });
  const exportButton = button('导出图文', 'soft', async () => {
    if (!active()) return;
    exportButton.disabled = true;
    exportOriginal.disabled = true;
    metadataButton.disabled = true;
    remove.disabled = true;
    exportButton.textContent = '正在准备…';
    let metadata = null;
    try {
      try {
        metadata = await native('galleryMetadata', item.id);
      } catch {
        // A readable permanent preview can still be exported without generation info.
      }
      if (!active()) return;
      if (metadata && metadata.promptCached !== true) {
        throw new Error('生成信息读取成功，但未能永久保存到图库，请检查手机空间后重试。');
      }
      exportButton.textContent = '正在生成…';
      const exported = await native('exportGalleryHtml', item.id);
      if (!active()) return;
      if (exported === true) {
        toast(metadata ? '已导出离线图文' : '已导出小预览；生成信息缺失已注明');
      } else {
        toast('已取消导出');
      }
    } catch (error) {
      if (!active()) return;
      toast(error && error.message ? error.message : '导出图文失败，请重试。');
    } finally {
      if (active()) {
        exportButton.disabled = false;
        exportOriginal.disabled = false;
        metadataButton.disabled = false;
        remove.disabled = false;
        exportButton.textContent = '导出图文';
      }
    }
  });

  heading.append(remove);
  actions.replaceChildren(
    metadataButton,
    button('返回图库', 'soft', () => {
      if (active()) returnToGallery();
    }),
    exportButton,
    ...(item.kind === 'copy' || item.sourceLinked ? [exportOriginal] : []),
  );
}

window.showGallery = showGallery;

const galleryDialog = document.getElementById('screen');
if (galleryDialog) {
  galleryDialog.addEventListener('close', () => {
    gallerySession += 1;
  });
}
