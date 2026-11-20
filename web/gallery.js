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
let galleryDesktopImportBusy = false;

function galleryUsesDesktop() {
  return typeof desktopApp !== 'undefined' && Boolean(desktopApp);
}

function galleryErrorMessage(error, fallback) {
  return error && typeof error.message === 'string' && error.message.trim()
    ? error.message.trim()
    : fallback;
}

async function galleryDesktopRequest(path, options = {}, fallback = '图库服务请求失败。') {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      ...options,
    });
  } catch {
    throw new Error('无法连接本机图库服务，请确认桌面端正在运行。');
  }

  const text = await response.text();
  let result = null;
  if (text.trim()) {
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error('本机图库服务返回了无法识别的数据。');
    }
  }
  if (!response.ok) {
    const detail = result && typeof result.error === 'string' ? result.error.trim() : '';
    throw new Error(detail ? `${fallback}：${detail}` : `${fallback}（HTTP ${response.status}）`);
  }
  return result;
}

async function saveDesktopGalleryPreview(name, summary) {
  if (!galleryUsesDesktop()) {
    throw new Error('当前不是 Windows 桌面端，无法保存到桌面图库。');
  }
  if (!summary || typeof summary !== 'object') {
    throw new Error('无法保存图库条目：生成信息缺失。');
  }
  const preview = typeof summary.preview === 'string' ? summary.preview.trim() : '';
  if (!/^data:image\/jpeg;base64,/.test(preview)) {
    throw new Error('无法保存图库条目：没有可用的 JPEG 小预览。');
  }

  const metadata = { ...summary };
  delete metadata.preview;
  delete metadata.galleryName;
  const itemName = typeof name === 'string' && name.trim() ? name.trim() : '未命名原图';
  let body;
  try {
    const fits = new TextEncoder().encode(JSON.stringify(metadata)).byteLength <= 2 * 1024 * 1024;
    body = JSON.stringify({ name: itemName, preview, metadata: fits ? metadata : null });
  } catch {
    throw new Error('无法保存图库条目：生成信息无法序列化。');
  }

  const result = await galleryDesktopRequest('/api/personal-gallery/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, '保存图库条目失败');
  if (!result || result.id === undefined || result.id === null) {
    throw new Error('保存图库条目失败：本机图库没有返回条目编号。');
  }
  return result;
}

window.saveDesktopGalleryPreview = saveDesktopGalleryPreview;

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

function galleryThumbnail(item, session, open = null) {
  const tile = button('', 'nai-gallery-tile', () => {
    if (session !== gallerySession) return;
    if (open) {
      open(tile);
      return;
    }
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
  image.classList.add('is-loading');
  image.addEventListener('load', () => {
    image.classList.remove('is-loading');
    image.classList.add('is-loaded');
    status.hidden = true;
  });
  image.addEventListener('error', () => {
    image.classList.remove('is-loading', 'is-loaded');
    status.hidden = false;
    status.textContent = '缩略图读取失败\n点按查看原图';
  });
  image.src = item.previewUrl || galleryImageUrl(item, true);
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
  if (galleryUsesDesktop()) {
    await galleryImportDesktop(session, trigger);
    return;
  }
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

function galleryDesktopImageFile(file) {
  if (!file) return false;
  return /^image\/(?:png|webp|jpeg)$/i.test(file.type || '')
    || /\.(?:png|webp|jpe?g)$/i.test(file.name || '');
}

function galleryPickDesktopImages() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg';
    input.multiple = true;
    input.hidden = true;
    let settled = false;
    const finish = files => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      finish(Array.from(input.files || []));
    }, { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    try { input.click(); }
    catch (error) { input.remove(); reject(error); }
  });
}

async function galleryImportDesktop(session, trigger, folder = null) {
  if (galleryDesktopImportBusy || session !== gallerySession) return;
  galleryDesktopImportBusy = true;
  const revision = screenRevision;
  const active = () => session === gallerySession && revision === screenRevision;
  const originalLabel = trigger.textContent;
  let stopped = false;
  const stop = button('停止导入', 'soft', () => {
    stopped = true;
    stop.disabled = true;
    stop.textContent = '正在停止…';
  });
  trigger.disabled = true;
  trigger.textContent = folder ? '正在准备导入…' : '选择原图…';

  try {
    const selected = folder ? null : await galleryPickDesktopImages();
    if (!active() || (!folder && !selected.length)) return;
    const localFiles = selected?.filter(galleryDesktopImageFile);
    const total = folder ? folder.total : localFiles.length;
    if (!total) return toast('没有找到 PNG、WebP 或 JPEG 图片。');
    const files = folder ? galleryFolderFiles(folder.folder.id, folder.pages) : localFiles;
    actions.append(stop);

    let imported = 0;
    let existing = 0;
    let failed = 0;
    let firstFailure = '';
    let index = 0;
    for await (const file of files) {
      if (stopped || !active()) break;
      trigger.textContent = `正在导入 ${++index}/${total}…`;
      try {
        const summary = folder ? await readSameOriginPromptPhoto(file.previewUrl) : await readLocalNovelAiImage(file);
        if (stopped || !active()) break;
        const result = await saveDesktopGalleryPreview(file.name, summary);
        if (result.added === false) existing += 1;
        else imported += 1;
      } catch (error) {
        failed += 1;
        firstFailure ||= `${file.name}：${galleryErrorMessage(error, '导入失败')}`;
      }
    }

    if (!active()) return;
    if (imported && !folder) showGallery(0);
    const message = [];
    if (imported) message.push(`已导入 ${imported} 张图片到本机图库`);
    if (existing) message.push(`${existing} 张已在图库`);
    if (failed) message.push(`${failed} 张读取失败，首个原因：${firstFailure}`);
    if (stopped) message.push('已停止，已保存的图片可继续查看');
    toast(message.length ? message.join('；') : '没有导入图片');
  } catch (error) {
    if (!active()) return;
    toast(galleryErrorMessage(error, '桌面图库导入失败，请重试。'));
  } finally {
    galleryDesktopImportBusy = false;
    stop.remove();
    if (active()) {
      trigger.disabled = false;
      trigger.textContent = originalLabel;
    }
  }
}

function galleryFolderPhotos(id, page, refresh = false) {
  const query = new URLSearchParams({ id, page: String(page) });
  if (refresh) query.set('refresh', '1');
  return galleryDesktopRequest(`/api/gallery-folders/images?${query}`, {}, '读取文件夹失败');
}

async function* galleryFolderFiles(id, pages) {
  for (let page = 0; page < pages; page++) {
    const listing = await galleryFolderPhotos(id, page);
    if (!listing.folder.available) throw new Error('图片文件夹已移动或暂时无法访问。');
    if (listing.page !== page) return;
    yield* listing.items;
  }
}

async function chooseGalleryFolder(session, trigger) {
  if (galleryDesktopImportBusy || session !== gallerySession) return;
  const revision = screenRevision;
  trigger.disabled = true;
  try {
    const result = await galleryDesktopRequest('/api/gallery-folders/pick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, '选择文件夹失败');
    if (result?.folder && session === gallerySession && revision === screenRevision) showGalleryFolder(result.folder);
  } catch (error) {
    if (revision === screenRevision) toast(galleryErrorMessage(error, '无法读取所选文件夹。'));
  } finally {
    trigger.disabled = false;
  }
}

function showGalleryFolder(folder) {
  const session = ++gallerySession;
  const returnPage = galleryPage;
  const returnScroll = body.scrollTop;
  const leave = () => showGallery(returnPage, returnScroll);
  const pageKey = `pocket-gallery-folder-page:${folder.id}`;

  async function showPage(page, scroll = 0, refresh = false) {
    openScreen(folder.name || '文件夹预览', leave);
    const revision = screenRevision;
    const active = () => session === gallerySession && revision === screenRevision;
    const remove = button('移除目录', 'soft', async () => {
      if (galleryDesktopImportBusy || !confirm('从本机图库移除这个文件夹？文件夹里的图片会保留。')) return;
      remove.disabled = true;
      try {
        await galleryDesktopRequest('/api/gallery-folders/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: folder.id }),
        }, '移除目录失败');
        if (active()) leave();
      } catch (error) {
        if (active()) toast(galleryErrorMessage(error, '移除目录失败。'));
      } finally { remove.disabled = false; }
    });
    actions.replaceChildren(button('返回本机图库', 'soft', leave),
      button('重新扫描', 'soft', () => { if (!galleryDesktopImportBusy) showPage(page, body.scrollTop, true); }), remove);
    const status = node('p', 'nai-gallery-note', '正在读取文件夹…');
    status.setAttribute('role', 'status');
    body.append(status);
    let current;
    try {
      current = await galleryFolderPhotos(folder.id, page, refresh);
    } catch (error) {
      if (active()) status.textContent = galleryErrorMessage(error, '读取文件夹失败。');
      return;
    }
    if (!active()) return;
    if (!current.folder.available) {
      status.textContent = '文件夹暂时无法访问。连接原来的磁盘或恢复文件夹位置，然后点击「重新扫描」。';
      return;
    }
    writeJsonStorage(pageKey, current.page);
    if (!current.items.length) {
      status.textContent = '文件夹里没有可读取的 PNG、WebP 或 JPEG 图片。';
      return;
    }
    status.textContent = `${current.total} 张图片 · 点图查看提示词与参数`;
    const all = button('整批存到图库', 'primary', () => galleryImportDesktop(session, all, current));
    actions.append(all);
    const move = target => {
      if (!galleryDesktopImportBusy) showPage(target);
    };
    if (current.pages > 1) body.append(pageJump(current.page, current.pages, move));
    const grid = node('div', 'nai-gallery-grid');
    for (const item of current.items) {
      const picture = { ...item, createdAt: item.modified };
      grid.append(galleryThumbnail(picture, session, async tile => {
        if (galleryDesktopImportBusy) return;
        tile.disabled = true;
        const previousScroll = body.scrollTop;
        try {
          const summary = await readSameOriginPromptPhoto(item.previewUrl);
          if (!active()) return;
          summary.galleryName = item.name;
          showPromptImport(summary, { back: () => showPage(current.page, previousScroll) });
        } catch (error) {
          if (revision === screenRevision) toast(galleryErrorMessage(error, '无法读取这张图片。'));
        } finally {
          tile.disabled = false;
        }
      }));
    }
    body.append(grid);
    if (current.pages > 1) body.append(pageSteps(current.page, current.pages, move));
    body.scrollTop = scroll;
  }

  const savedPage = readJsonStorageOr(pageKey, 0);
  showPage(Number.isSafeInteger(savedPage) && savedPage >= 0 ? savedPage : 0, 0, true);
}

async function appendGalleryFolders(target, session, revision) {
  try {
    const { folders } = await galleryDesktopRequest('/api/gallery-folders');
    if (session !== gallerySession || revision !== screenRevision || !folders.length) return;
    const items = node('div', 'tool-actions');
    for (const folder of folders) {
      const name = folder.available ? folder.name : `${folder.name}（暂不可用）`;
      items.append(button(name, 'soft', () => showGalleryFolder(folder)));
    }
    target.append(node('h2', '', '已添加的文件夹'), items);
    target.hidden = false;
  } catch (error) {
    if (session === gallerySession && revision === screenRevision) {
      target.append(node('p', 'nai-gallery-note', galleryErrorMessage(error, '无法读取已添加的文件夹。')));
      target.hidden = false;
    }
  }
}

function galleryListActions(session) {
  const trigger = button('导入原图', 'primary', () => galleryImport(session, trigger));
  actions.replaceChildren(button('外站找图', 'soft', () => {
    const page = galleryPage;
    const scroll = body.scrollTop;
    showTagGalleries('', () => showGallery(page, scroll));
  }), trigger);
  if (galleryUsesDesktop()) {
    const folder = button('选择图片文件夹', 'soft', () => chooseGalleryFolder(session, folder));
    actions.append(folder);
  }
}

async function galleryLoad(session, requestedPage, requestedScroll) {
  openScreen('原图图库', galleryUsesDesktop() ? showDesktopGallery : null);
  const revision = screenRevision;
  galleryListActions(session);

  const loading = node('div', 'nai-gallery-loading', '正在读取本地图库…');
  loading.setAttribute('role', 'status');
  body.append(loading);

  try {
    const listed = galleryUsesDesktop()
      ? await galleryDesktopRequest(
        `/api/personal-gallery?page=${encodeURIComponent(String(requestedPage))}`,
        {},
        '读取本机图库失败',
      )
      : await native('listGallery', String(requestedPage));
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
    if (galleryUsesDesktop()) {
      const folders = node('section', 'nai-gallery-heading');
      folders.hidden = true;
      body.append(folders);
      appendGalleryFolders(folders, session, revision);
    }

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

function galleryEscapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function galleryMetadataValueText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function galleryMetadataField(metadata, keys) {
  if (!metadata || typeof metadata !== 'object') return '';
  for (const key of keys) {
    if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
      return galleryMetadataValueText(metadata[key]);
    }
  }
  return '';
}

function galleryBlobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
        resolve(reader.result);
      } else {
        reject(new Error('小预览编码失败。'));
      }
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('读取小预览失败。')), { once: true });
    reader.readAsDataURL(blob);
  });
}

function galleryDownloadName(name) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 100) || '图库条目';
  return `${base}-离线图文.html`;
}

function galleryDownloadHtml(filename, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function galleryExportDesktopHtml(item) {
  let response;
  try {
    response = await fetch(galleryImageUrl(item, false), {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new Error('无法读取图库小预览，请确认桌面端正在运行。');
  }
  if (!response.ok) {
    throw new Error(`读取图库小预览失败（HTTP ${response.status}）。`);
  }
  const sourceBlob = await response.blob();
  if (!sourceBlob.size) throw new Error('图库小预览为空，无法导出。');
  const previewBlob = sourceBlob.type.startsWith('image/')
    ? sourceBlob
    : new Blob([sourceBlob], { type: 'image/jpeg' });
  const previewUrl = await galleryBlobDataUrl(previewBlob);

  let metadata = null;
  let metadataNote = '';
  try {
    metadata = await galleryDesktopRequest(
      `/api/personal-gallery/metadata?id=${encodeURIComponent(String(item.id))}`,
      {},
      '读取生成信息失败',
    );
  } catch (error) {
    metadataNote = galleryErrorMessage(error, '读取生成信息失败。');
  }
  const facts = [item.format, galleryFormatBytes(item.bytes), galleryFormatDate(item.createdAt)].filter(Boolean).join(' · ');
  return galleryWriteDesktopHtml(galleryItemName(item), previewUrl, metadata, facts, metadataNote);
}

function galleryWriteDesktopHtml(title, previewUrl, metadata, facts = '', metadataNote = '') {
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(previewUrl || '')) {
    throw new Error('没有可导出的小预览。');
  }
  let metadataForExport = metadata;
  if (metadataForExport && typeof metadataForExport === 'object') {
    metadataForExport = { ...metadataForExport };
    delete metadataForExport.preview;
  }
  const positivePrompt = galleryMetadataField(metadataForExport, [
    'prompt',
    'positivePrompt',
    'positive_prompt',
    'positive',
  ]);
  const negativePrompt = galleryMetadataField(metadataForExport, [
    'negativePrompt',
    'negative_prompt',
    'negative',
  ]);
  const metadataText = metadataForExport
    ? galleryMetadataValueText(metadataForExport)
    : metadataNote || '此条目没有已保存的生成信息。';
  const promptSections = [
    positivePrompt
      ? `<section><h2>正向提示词</h2><pre>${galleryEscapeHtml(positivePrompt)}</pre></section>`
      : '',
    negativePrompt
      ? `<section><h2>负向提示词</h2><pre>${galleryEscapeHtml(negativePrompt)}</pre></section>`
      : '',
  ].join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${galleryEscapeHtml(title)} · 离线图文</title>
<style>
:root { color-scheme: dark; font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
body { margin: 0; background: #101116; color: #ececf1; }
main { width: min(920px, calc(100% - 32px)); margin: 32px auto; }
header { margin-bottom: 20px; }
h1 { margin: 4px 0 8px; font-size: clamp(24px, 5vw, 40px); }
h2 { margin: 0 0 10px; font-size: 17px; }
p, figcaption, footer { color: #aeb0bc; line-height: 1.6; }
figure { margin: 0 0 20px; padding: 16px; background: #191b22; border-radius: 16px; text-align: center; }
img { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto 10px; border-radius: 10px; }
section { margin: 14px 0; padding: 16px; background: #191b22; border-radius: 12px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #e8e8ed; font: 13px/1.65 Consolas, "Microsoft YaHei", monospace; }
footer { margin-top: 24px; font-size: 13px; }
</style>
</head>
<body>
<main>
<header>
<p>个人图库离线图文${facts ? ` · ${galleryEscapeHtml(facts)}` : ''}</p>
<h1>${galleryEscapeHtml(title)}</h1>
</header>
<figure>
<img src="${galleryEscapeHtml(previewUrl)}" alt="${galleryEscapeHtml(title)}">
<figcaption>小预览已嵌入此文件，可离线查看。</figcaption>
</figure>
${promptSections}
<section>
<h2>提示词与参数</h2>
<pre>${galleryEscapeHtml(metadataText)}</pre>
</section>
</main>
</body>
</html>`;
  galleryDownloadHtml(galleryDownloadName(title), html);
  return Boolean(metadataForExport);
}

function showGalleryDetail(item, readOnOpen = true) {
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

  const metadataButton = button('查看提示词 / 参数', 'primary', () => readMetadata());
  const metadataStatus = node('p', 'nai-gallery-note');
  metadataStatus.setAttribute('role', 'status');
  info.append(metadataStatus);

  async function readMetadata() {
    if (!active()) return;
    metadataButton.disabled = true;
    metadataButton.textContent = '正在读取…';
    metadataStatus.textContent = '正在自动读取这张图的提示词与参数…';
    try {
      const summary = galleryUsesDesktop()
        ? await galleryDesktopRequest(
          `/api/personal-gallery/metadata?id=${encodeURIComponent(String(item.id))}`,
          {},
          '读取生成信息失败',
        )
        : await native('galleryMetadata', item.id);
      if (!active()) return;
      if (!summary) {
        metadataStatus.textContent = '这张图没有可读取的生成信息。';
        return;
      }
      showPromptImport(summary, {
        back: () => showGalleryDetail(item, false),
        galleryItem: item,
      });
    } catch (error) {
      if (!active()) return;
      metadataStatus.textContent = galleryErrorMessage(error, '读取生成信息失败。');
    } finally {
      if (active()) {
        metadataButton.disabled = false;
        metadataButton.textContent = '查看提示词 / 参数';
      }
    }
  }

  const remove = button('从图库删除', 'subtle danger compact', async () => {
    if (!active()) return;
    const message = galleryUsesDesktop()
      ? '删除图库中的小预览缓存和已保存的生成信息？用户原图文件会保留。'
      : item.kind === 'preview'
        ? '删除此条目的小预览和已保存的生成信息？手机原文件会保留。'
        : '删除 App 内的完整副本和已保存的生成信息？手机原文件会保留。';
    if (!confirm(message)) return;
    remove.disabled = true;
    metadataButton.disabled = true;
    exportButton.disabled = true;
    try {
      const deleted = galleryUsesDesktop()
        ? await galleryDesktopRequest('/api/personal-gallery/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        }, '删除图库缓存失败')
        : await native('deleteGalleryImage', item.id);
      if (!active()) return;
      if (galleryUsesDesktop() && typeof deleted !== 'boolean') {
        throw new Error('图库服务返回了异常的删除结果。');
      }
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
      if (galleryUsesDesktop()) {
        const hasMetadata = await galleryExportDesktopHtml(item);
        if (active()) {
          toast(hasMetadata ? '已导出离线图文 HTML' : '已导出离线 HTML；生成信息缺失已注明');
        }
        return;
      }
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
  if (readOnOpen) readMetadata();
}

window.showGallery = showGallery;

const galleryDialog = document.getElementById('screen');
if (galleryDialog) {
  galleryDialog.addEventListener('close', () => {
    gallerySession += 1;
  });
}
