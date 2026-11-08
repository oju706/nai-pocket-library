'use strict';

const galleryPageSize = 24;
const galleryDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
let gallerySession = 0;

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
    if (session === gallerySession) showGalleryDetail(item);
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
    node('p', '', '从 NovelAI 保存并下载的原图会留在本机。导入后可在这里查看原图和生成信息。'),
  );
  return empty;
}

async function galleryImport(session, trigger) {
  if (session !== gallerySession) return;
  trigger.disabled = true;
  trigger.textContent = '正在导入…';
  try {
    const result = await native('importGallery');
    if (session !== gallerySession) return;
    if (!result) {
      trigger.disabled = false;
      trigger.textContent = '导入原图';
      return;
    }
    const added = Number.isFinite(Number(result.added)) ? Number(result.added) : 0;
    const skipped = Number.isFinite(Number(result.skipped)) ? Number(result.skipped) : 0;
    showGallery();
    if (added || skipped) {
      toast(result.message || `已导入 ${added} 张原图${skipped ? `，跳过 ${skipped} 张` : ''}`);
    } else {
      toast('没有新增原图');
    }
  } catch (error) {
    if (session !== gallerySession) return;
    trigger.disabled = false;
    trigger.textContent = '导入原图';
    toast(error && error.message ? error.message : '导入原图失败。');
  }
}

function galleryListActions(session) {
  const trigger = button('导入原图', 'primary', () => galleryImport(session, trigger));
  actions.replaceChildren(trigger);
}

async function galleryLoad(session) {
  openScreen('原图图库');
  galleryListActions(session);

  const loading = node('div', 'nai-gallery-loading', '正在读取本地图库…');
  loading.setAttribute('role', 'status');
  body.append(loading);

  try {
    const listed = await native('listGallery');
    if (session !== gallerySession) return;
    if (!Array.isArray(listed)) throw new Error('图库数据格式不正确。');

    const items = listed
      .filter(item => item && item.id != null)
      .slice()
      .sort((left, right) => {
        const timeDifference = galleryDateValue(right.createdAt) - galleryDateValue(left.createdAt);
        return timeDifference || String(right.id).localeCompare(String(left.id));
      });

    body.replaceChildren();
    const heading = node('section', 'nai-gallery-heading');
    heading.append(
      node('p', 'nai-gallery-eyebrow', '仅保存在此设备'),
      node('h2', '', `本地原图 · ${items.length} 张`),
      node('p', 'nai-gallery-note', '按保存时间从新到旧排列。点按缩略图查看原图与生成信息。'),
    );
    body.append(heading);

    if (!items.length) {
      body.append(galleryEmptyState());
      return;
    }

    const grid = node('div', 'nai-gallery-grid');
    const footer = node('div', 'nai-gallery-footer');
    body.append(grid, footer);
    let shown = 0;

    function renderNextBatch() {
      if (session !== gallerySession) return;
      const end = Math.min(shown + galleryPageSize, items.length);
      for (; shown < end; shown++) grid.append(galleryThumbnail(items[shown], session));
      footer.replaceChildren();
      if (shown < items.length) {
        footer.append(node('span', 'nai-gallery-count', `已显示 ${shown} / ${items.length}`));
        footer.append(button('加载更多', 'soft', renderNextBatch));
      } else if (items.length > galleryPageSize) {
        footer.append(node('span', 'nai-gallery-count', `已显示全部 ${items.length} 张`));
      }
    }

    renderNextBatch();
  } catch (error) {
    if (session !== gallerySession) return;
    body.replaceChildren();
    const failure = node('div', 'nai-gallery-empty nai-gallery-failure');
    failure.append(
      node('h2', '', '图库读取失败'),
      node('p', '', error && error.message ? error.message : '请稍后重试。'),
    );
    const retry = button('重新读取', 'primary', () => {
      if (session === gallerySession) galleryLoad(session);
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

function showGallery() {
  const session = ++gallerySession;
  galleryLoad(session);
}

function galleryDetailImage(item) {
  const stage = node('div', 'nai-gallery-image-stage');
  const frame = node('div', 'nai-gallery-image-frame');
  const controls = node('div', 'nai-gallery-image-controls');
  stage.append(frame, controls);

  let naturalSize = false;
  const sizeToggle = button('原始尺寸', 'nai-gallery-size-toggle', () => {
    naturalSize = !naturalSize;
    frame.classList.toggle('nai-gallery-is-natural', naturalSize);
    sizeToggle.textContent = naturalSize ? '适应屏幕' : '原始尺寸';
    sizeToggle.setAttribute('aria-pressed', String(naturalSize));
  });
  sizeToggle.setAttribute('aria-pressed', 'false');
  controls.append(sizeToggle);

  function loadImage() {
    const loading = node('div', 'nai-gallery-image-status', '正在读取完整原图…');
    loading.setAttribute('role', 'status');
    const image = node('img', 'nai-gallery-full-image');
    image.alt = `完整原图：${galleryItemAlt(item)}`;
    image.decoding = 'async';
    image.hidden = true;
    image.addEventListener('load', () => {
      image.hidden = false;
      loading.remove();
    });
    image.addEventListener('error', () => {
      const failure = node('div', 'nai-gallery-image-status nai-gallery-image-error');
      failure.append(node('span', '', '完整原图读取失败。'), button('重试', 'soft', loadImage));
      frame.replaceChildren(failure);
    });
    frame.replaceChildren(loading, image);
    image.src = galleryImageUrl(item, false);
  }
  loadImage();
  return stage;
}

function showGalleryDetail(item) {
  const session = ++gallerySession;
  openScreen('原图详情', showGallery);

  const date = galleryFormatDate(item.createdAt);
  const facts = [item.format, galleryFormatBytes(item.bytes), date].filter(Boolean).join(' · ');
  const heading = node('section', 'nai-gallery-detail-heading');
  heading.append(
    node('h2', '', galleryItemName(item)),
    node('p', 'nai-gallery-note', facts),
  );
  body.append(galleryDetailImage(item), heading);

  const metadataButton = button('查看提示词 / 参数', 'primary', async () => {
    if (session !== gallerySession) return;
    metadataButton.disabled = true;
    metadataButton.textContent = '正在读取…';
    try {
      const summary = await native('galleryMetadata', item.id);
      if (session !== gallerySession) return;
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
      if (session !== gallerySession) return;
      metadataButton.disabled = false;
      metadataButton.textContent = '查看提示词 / 参数';
      toast(error && error.message ? error.message : '读取生成信息失败。');
    }
  });

  actions.replaceChildren(
    button('返回图库', 'soft', () => {
      if (session === gallerySession) showGallery();
    }),
    metadataButton,
  );
}

window.showGallery = showGallery;

const galleryDialog = document.getElementById('screen');
if (galleryDialog) {
  galleryDialog.addEventListener('close', () => {
    gallerySession += 1;
  });
}
