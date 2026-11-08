'use strict';

(() => {
  const addressKey = 'pocket-online-pack-address';
  const pageSize = 24;
  const maxCount = 20;
  const maxBytes = 32 * 1024 * 1024;
  const sharedZipUrl = 'https://huggingface.co/datasets/okawaritsuika/nai-shared-styles/resolve/main/NAImakeArtistGroup_shared_images_20261024_webp.zip?download=true';
  const ratings = [['sfw', 'SFW'], ['nsfw', 'NSFW'], ['unknown', '未分级']];
  const sections = { artist: '画师', character: '同人角色', knowledge: '画面提示词知识' };

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  function loadImage(frame, path, title, thumbnail, onError) {
    const status = node('span', 'online-pack-image-status', thumbnail ? '正在读取缩略图…' : '正在读取原图…');
    const image = node('img', '');
    image.alt = title;
    image.decoding = 'async';
    if (thumbnail) image.loading = 'lazy';
    image.hidden = true;
    image.addEventListener('load', () => {
      if (image.parentNode !== frame) return;
      image.hidden = false;
      status.remove();
    });
    image.addEventListener('error', () => {
      if (image.parentNode !== frame) return;
      status.textContent = thumbnail ? '缩略图读取失败' : '原图读取失败';
      if (onError) onError();
    });
    frame.replaceChildren(status, image);
    image.src = path;
    return image;
  }

  function showPack(back, mode) {
    const remote = mode === 'remote';
    const local = mode === 'local';
    const shared = remote || local;
    const packLabel = remote ? '在线社区画风' : local ? '共享画风图包' : '在线图包';
    const saveAction = remote ? 'saveRemoteSharedStylePhotos' : local ? 'saveSharedStylePhotos' : 'saveOnlinePhotos';
    let address = '';
    if (!shared) {
      try { address = localStorage.getItem(addressKey) || ''; } catch { /* The address can still be entered. */ }
    }
    let catalog = null;
    let rating = 'sfw';
    let showRestricted = false;
    let searchTerm = '';
    let page = 0;
    let openedShared = false;
    let saving = false;
    let updateSave = () => {};
    const selected = new Map();
    const selectionBytes = () => [...selected.values()].reduce((sum, item) => sum + item.bytes, 0);

    function replaceCatalog(next) {
      if (next !== null && (!next?.revision || !Array.isArray(next.images))) throw new Error('图包目录格式不正确。');
      const changed = catalog?.revision !== next?.revision;
      catalog = next;
      if (changed) {
        selected.clear();
        rating = 'sfw';
        showRestricted = false;
        searchTerm = '';
        page = 0;
      }
      return changed;
    }

    function bindSaveState(update) {
      const screen = screenRevision;
      updateSave = () => { if (screen === screenRevision) update(); };
      updateSave();
    }

    async function savePhotos(ids) {
      if (saving || !ids.length) return;
      const screen = screenRevision;
      const revision = catalog.revision;
      saving = true;
      updateSave();
      try {
        const result = await native(saveAction, JSON.stringify({ revision, ids }));
        if (screen !== screenRevision) return;
        if (result === true) toast(ids.length === 1 ? '已保存原图' : '已保存原图 ZIP');
        else if (result !== null) throw new Error('没有收到保存结果。');
      } catch (error) {
        if (screen === screenRevision) toast(error?.message || '保存原图失败，请重试。');
      } finally {
        saving = false;
        updateSave();
      }
    }

    function showDetail(item) {
      openScreen(`${packLabel} · 图片详情`, showList);
      const screen = screenRevision;
      const title = item.title || item.id;
      const frame = node('div', 'online-pack-detail-image');
      const facts = [item.model, sections[item.section], item.source, sizeText(item.bytes)].filter(Boolean);
      const view = node('section', 'online-pack-detail');
      const original = button('查看完整原图', 'soft', () => showImage(!showOriginal));
      const saveLabel = local ? '保存原图' : '下载原图';
      const save = button(saveLabel, 'soft', () => savePhotos([item.id]));
      const metadata = button('查看提示词与参数', 'primary', async () => {
        metadata.disabled = true;
        metadata.textContent = '正在读取…';
        try {
          const data = await native('photoMetadata', item.original);
          if (screen !== screenRevision) return;
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('没有收到图片的读取结果。');
          showPromptImport(data, {
            back: () => showDetail(item),
            resourcePhoto: {
              title, label: packLabel, source: item.source || catalog.title,
              preview: image.hidden ? null : image,
            },
          });
        } catch (error) {
          if (screen !== screenRevision) return;
          toast(error?.message || '读取生成信息失败，请重试。');
          metadata.disabled = false;
          metadata.textContent = '查看提示词与参数';
        }
      });
      let showOriginal = false;
      let image;
      function showImage(full) {
        showOriginal = full;
        original.textContent = full ? '返回缩略图' : '查看完整原图';
        image = loadImage(frame, full ? item.original : item.thumbnail, title, !full, full ? () => {
          if (screen !== screenRevision) return;
          showImage(false);
          toast('原图读取失败，已切回缩略图。');
        } : null);
      }
      view.append(node('h2', '', title), node('p', 'online-pack-note', facts.join(' · ')), frame, original);
      if (shared && /^https:\/\/arca\.live\/b\/aiart\/\d+$/.test(item.source)) {
        view.append(button('在浏览器打开原帖', 'text-button', () => openLink(item.source)));
      }
      body.append(view);
      showImage(false);
      actions.append(save, metadata);
      bindSaveState(() => {
        save.disabled = saving;
        save.textContent = saving ? '准备保存…' : saveLabel;
      });
    }

    function tile(item) {
      const title = item.title || item.id;
      const card = node('article', 'online-pack-tile');
      const open = button('', 'online-pack-open-photo', () => showDetail(item));
      open.setAttribute('aria-label', `查看 ${title}`);
      const frame = node('span', 'online-pack-thumbnail');
      const label = node('label', 'online-pack-select');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(item.id);
      checkbox.setAttribute('aria-label', `选择 ${title}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (selected.size >= maxCount || selectionBytes() + item.bytes > maxBytes) {
            checkbox.checked = false;
            toast('每批最多选择 20 张，原图合计最多 32 MiB。');
            return;
          }
          selected.set(item.id, item);
        } else {
          selected.delete(item.id);
        }
        updateSave();
      });
      const caption = node('span', 'online-pack-caption');
      caption.append(node('strong', '', title), node('span', 'online-pack-note', [item.model, sections[item.section]].filter(Boolean).join(' · ')));
      open.append(frame, caption);
      label.append(checkbox, node('span', '', '选择'));
      card.append(open, label);
      loadImage(frame, item.thumbnail, title, true);
      return card;
    }

    function showList() {
      openScreen(packLabel, back);
      if (!window.Pocket) {
        body.append(node('p', 'online-pack-note', `请在安卓 App 中打开${packLabel}。`));
        return;
      }
      const screen = screenRevision;
      const source = node(shared ? 'section' : 'details', 'online-pack-source');
      const form = node('form', 'online-pack-form');
      const input = node('input');
      input.value = address;
      input.placeholder = 'https://github.com/用户名/仓库名';
      input.inputMode = 'url';
      input.spellcheck = false;
      input.autocapitalize = 'none';
      input.maxLength = 2048;
      const submit = node('button', 'primary', '打开图包');
      submit.type = 'submit';
      const status = node('p', 'online-pack-note');
      status.setAttribute('role', 'status');
      status.hidden = true;
      const search = node('input');
      search.type = 'search';
      search.maxLength = 160;
      search.value = searchTerm;
      const searchField = field('搜索原帖编号或标题', search);
      const importZip = button('选择共享画风 ZIP', 'primary compact', () => loadShared('importSharedStylePack'));
      const forgetZip = button('移除图包', 'soft compact', () => {
        if (confirm('移除 App 中的共享图包？手机原 ZIP 文件会保留。')) return loadShared('forgetSharedStylePack');
      });
      const retry = button('重试读取在线图包', 'primary compact', () => loadCatalog());
      retry.hidden = true;
      if (shared) {
        const tools = node('div', 'online-pack-heading');
        if (remote) {
          tools.append(retry,
            button('导入本地 ZIP', 'soft compact', () => showPack(showList, 'local')),
            button('自定义 GitHub 仓库', 'soft compact', () => showPack(showList, 'custom')));
        } else {
          tools.append(importZip, forgetZip);
        }
        tools.append(button('下载完整 ZIP', 'soft compact', () => openLink(catalog?.downloadUrl || sharedZipUrl)));
        const description = remote ? '直接读取内置社区图包目录，图片按需加载。' : '在手机文件里选择共享画风 ZIP，直接浏览包内图片。';
        source.append(node('p', 'online-pack-note', description), tools, searchField, status);
      } else {
        source.open = !catalog;
        form.append(field('GitHub 仓库或 online-pack.json 链接', input), submit);
        source.append(node('summary', '', '图包地址'), form, status);
      }
      const progress = node('p', 'online-pack-note');
      progress.setAttribute('role', 'status');
      progress.hidden = true;
      const content = node('div', 'online-pack-content');
      body.append(source, progress, content);

      function renderCatalog() {
        content.replaceChildren();
        actions.replaceChildren();
        searchField.hidden = forgetZip.hidden = !catalog;
        search.value = searchTerm;
        if (!catalog) return;
        const heading = node('div', 'online-pack-heading');
        heading.append(node('h2', '', catalog.title));
        if (!local) heading.append(button('检查图包更新', 'soft compact', () => loadCatalog(address, true)));
        content.append(heading, node('p', 'online-pack-note', `目录共 ${catalog.images.length} 张，选图后可单张保存原图或多张保存为 ZIP。`));
        if (!shared) {
          const filters = node('div', 'segmented online-pack-filters');
          for (const [value, label] of ratings) {
            const option = button(label, '', () => {
              if (rating === value) return;
              rating = value;
              page = 0;
              renderCatalog();
            });
            option.setAttribute('aria-pressed', String(rating === value));
            filters.append(option);
          }
          content.append(filters);
        }
        const view = node('div', 'online-pack-results');
        content.append(view);
        const query = searchTerm.normalize('NFKC').trim().toLowerCase();
        const images = shared
          ? catalog.images.filter(item => !query || [item.title, item.id, item.postId, item.source].some(value => String(value ?? '').normalize('NFKC').toLowerCase().includes(query)))
          : catalog.images.filter(item => item.rating === rating);
        if (shared && query) view.append(node('p', 'online-pack-note', `找到 ${images.length} 张。`));
        if (!images.length) {
          view.append(node('p', 'online-pack-note', shared ? '没有符合条件的图片。' : '这个分级暂时没有图片。'));
        } else if ((shared || rating === 'nsfw') && !showRestricted) {
          const note = shared ? '这些图片未分级，可能含成人内容。' : `有 ${images.length} 张标注为 NSFW 的图片。`;
          view.append(node('p', 'online-pack-note', note),
            button(shared ? '显示未分级图片' : '显示 NSFW 图片', 'soft', () => { showRestricted = true; renderCatalog(); }));
        } else {
          if (shared) view.append(button('折叠未分级图片', 'soft compact', () => { showRestricted = false; renderCatalog(); }));
          const grid = node('div', 'online-pack-grid');
          grid.append(...images.slice(page * pageSize, (page + 1) * pageSize).map(tile));
          view.append(grid);
          const pages = Math.ceil(images.length / pageSize);
          if (pages > 1) {
            const nav = node('div', 'online-pack-pagination');
            const move = (amount) => { page += amount; renderCatalog(); body.scrollTop = 0; };
            const previous = button('上一页', 'soft', () => move(-1));
            const next = button('下一页', 'soft', () => move(1));
            previous.disabled = page === 0;
            next.disabled = page === pages - 1;
            nav.append(previous, node('span', 'online-pack-note', `${page + 1} / ${pages} 页`), next);
            view.append(nav);
          }
        }
        const toolbar = node('div', 'online-pack-export');
        const count = node('p', 'online-pack-note');
        count.setAttribute('aria-live', 'polite');
        const clear = button('清空选择', 'soft compact', () => { selected.clear(); renderCatalog(); });
        const save = button('保存所选原图', 'primary compact', () => savePhotos([...selected.keys()]));
        const buttons = node('div', 'online-pack-export-buttons');
        buttons.append(clear, save);
        toolbar.append(count, buttons);
        actions.append(toolbar);
        bindSaveState(() => {
          count.textContent = `已选 ${selected.size} / ${maxCount} 张 · ${sizeText(selectionBytes())} / 32 MiB`;
          clear.disabled = saving || !selected.size;
          save.disabled = saving || !selected.size;
          save.textContent = saving ? '准备保存…' : selected.size > 1 ? '保存所选 ZIP' : '保存所选原图';
        });
      }

      async function loadShared(action) {
        if (importZip.disabled || saving) return;
        importZip.disabled = forgetZip.disabled = search.disabled = true;
        status.hidden = false;
        status.textContent = action === 'importSharedStylePack' ? '请选择 ZIP，选好后将读取图片目录…' : '正在处理共享图包…';
        content.replaceChildren();
        actions.replaceChildren();
        try {
          const result = await native(action);
          if (screen !== screenRevision) return;
          if (action === 'forgetSharedStylePack') {
            if (result !== true) throw new Error('没有收到移除结果。');
            replaceCatalog(null);
            toast('已移除共享图包');
          } else if (action === 'openSharedStylePack' || result !== null) {
            replaceCatalog(result);
            if (action === 'importSharedStylePack') toast('已打开共享画风图包');
          }
          status.hidden = true;
        } catch (error) {
          if (screen !== screenRevision) return;
          status.textContent = error?.message || '共享图包无法读取，请重新选择 ZIP。';
        } finally {
          if (screen === screenRevision) {
            importZip.disabled = forgetZip.disabled = search.disabled = false;
            renderCatalog();
          }
        }
      }

      async function loadCatalog(url, checking = false) {
        if (submit.disabled || saving) return;
        const feedback = checking && !remote ? progress : status;
        const scroll = body.scrollTop;
        let changed = false;
        feedback.hidden = false;
        if (!remote && !url) { feedback.textContent = '请填写公开的 GitHub 图包地址。'; return; }
        submit.disabled = true;
        input.disabled = true;
        retry.disabled = search.disabled = true;
        feedback.textContent = checking ? '正在检查图包更新…' : '正在读取图包目录…';
        content.replaceChildren();
        actions.replaceChildren();
        try {
          const result = remote ? await native('openRemoteSharedStylePack') : await native('openOnlinePack', url);
          if (screen !== screenRevision) return;
          if (!result) throw new Error('图包目录格式不正确。');
          changed = replaceCatalog(result);
          if (remote) {
            retry.hidden = true;
          } else {
            input.value = address = url;
            try { localStorage.setItem(addressKey, address); } catch { /* Browsing does not require storage. */ }
            source.open = false;
          }
          status.hidden = true;
          if (checking) toast(changed ? '图包目录已更新' : '图包目录已是最新');
        } catch (error) {
          if (screen !== screenRevision) return;
          const message = error?.message || '图包目录读取失败，请重试。';
          if (remote) {
            retry.hidden = false;
            status.textContent = message;
          } else if (checking) toast(message);
          else {
            source.open = true;
            status.textContent = message;
          }
        } finally {
          if (screen === screenRevision) {
            submit.disabled = false;
            input.disabled = false;
            retry.disabled = search.disabled = false;
            progress.hidden = true;
            renderCatalog();
            if (checking && !changed) body.scrollTop = scroll;
          }
        }
      }

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        return loadCatalog(input.value.trim());
      });
      search.addEventListener('input', () => {
        searchTerm = search.value;
        page = 0;
        renderCatalog();
      });
      renderCatalog();
      if (remote && !catalog) loadCatalog();
      if (local && !openedShared) {
        openedShared = true;
        loadShared('openSharedStylePack');
      }
    }

    showList();
  }

  window.showOnlinePack = (back = null) => showPack(back, 'custom');
  window.showSharedStylePack = (back = null) => showPack(back, 'local');
  window.showRemoteSharedStylePack = (back = null) => showPack(back, 'remote');
})();
