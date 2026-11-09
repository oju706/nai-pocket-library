'use strict';

(() => {
  const addressKey = 'pocket-online-pack-address';
  const recentKey = 'pocket-online-pack-recent';
  const recentLimit = 100;
  const pageSize = 24;
  const maxCount = 20;
  const maxBytes = 32 * 1024 * 1024;
  const sharedZipUrl = 'https://huggingface.co/datasets/okawaritsuika/nai-shared-styles/resolve/main/NAImakeArtistGroup_shared_images_20261024_webp.zip?download=true';
  const ratings = [['sfw', 'SFW'], ['nsfw', 'NSFW'], ['unknown', '未分级']];
  const modelFamilies = ['V5', 'V4.5', 'V4', 'V3'];
  const sections = { artist: '画师', character: '同人角色', knowledge: '画面提示词知识' };
  let recentRecords = null;

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  function loadImage(frame, path, title, thumbnail, onError) {
    const status = node('span', 'online-pack-image-status', thumbnail ? '正在读取缩略图…' : '正在读取原图…');
    const image = node('img', 'online-pack-image-pending');
    image.alt = title;
    image.decoding = 'async';
    if (thumbnail) image.loading = 'lazy';
    image.addEventListener('load', () => {
      if (image.parentNode !== frame) return;
      image.className = '';
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

  function groupByPost(images) {
    const groups = new Map();
    for (const item of images) {
      const id = String(item.postId ?? '');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    return groups;
  }

  function showPack(back, mode, preset = null) {
    const presetMode = mode === 'preset';
    const customMode = mode === 'custom';
    const remote = mode === 'remote';
    const local = mode === 'local';
    const shared = remote || local;
    const packLabel = presetMode ? preset.title : remote ? '在线社区画风' : local ? '共享画风图包' : '在线图包';
    const saveAction = remote ? 'saveRemoteSharedStylePhotos' : local ? 'saveSharedStylePhotos' : 'saveOnlinePhotos';
    let address = '';
    if (presetMode) {
      address = preset.address;
    } else if (!shared) {
      try { address = localStorage.getItem(addressKey) || ''; } catch { /* The address can still be entered. */ }
    }
    let catalog = null;
    let modelLabels = new Map();
    let modelFilter = '';
    const defaultRating = presetMode && ['sfw', 'nsfw', 'unknown'].includes(preset.defaultRating)
      ? preset.defaultRating : 'sfw';
    let rating = defaultRating;
    let showRestricted = false;
    let searchTerm = '';
    let page = 0;
    let byPost = shared;
    let postView = null;
    let recentView = false;
    let recentOrigin = null;
    let columns = 2;
    let listScroll = 0;
    let openedShared = false;
    let saving = false;
    let updateSave = () => {};
    const selected = new Map();
    const photoVisibility = new Map();
    const recentPhotoVisibility = new Map();
    const originalDetails = new Set();
    let recentShowRestricted = false;
    if (recentRecords === null) recentRecords = readRecentRecords();
    const selectionBytes = () => [...selected.values()].reduce((sum, item) => sum + item.bytes, 0);
    const itemsPerPage = () => shared ? columns * 12 : pageSize;

    function readRecentRecords() {
      try {
        const saved = JSON.parse(localStorage.getItem(recentKey) || '[]');
        if (!Array.isArray(saved)) return [];
        const seen = new Set();
        return saved
          .map(record => ({
            mode: record?.mode,
            revision: record?.revision,
            imageId: String(record?.imageId ?? ''),
            viewedAt: Number(record?.viewedAt),
          }))
          .filter(record => (record.mode === 'remote' || record.mode === 'local') &&
            (typeof record.revision === 'string' || typeof record.revision === 'number') &&
            record.imageId && Number.isFinite(record.viewedAt))
          .sort((left, right) => right.viewedAt - left.viewedAt)
          .filter(record => {
            const key = `${record.mode}\n${record.revision}\n${record.imageId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, recentLimit);
      } catch {
        return [];
      }
    }

    function saveRecentRecords() {
      try {
        localStorage.setItem(recentKey, JSON.stringify(recentRecords));
      } catch { /* Recent browsing remains available for this session. */ }
    }

    function currentRecentRecords() {
      const revision = String(catalog?.revision ?? '');
      return recentRecords.filter(record => record.mode === mode && String(record.revision) === revision);
    }

    function recordRecent(item) {
      if (!shared || !catalog) return;
      const imageId = String(item.id);
      const revision = catalog.revision;
      recentRecords = [
        { mode, revision, imageId, viewedAt: Date.now() },
        ...recentRecords.filter(record => record.mode !== mode ||
          String(record.revision) !== String(revision) || record.imageId !== imageId),
      ].slice(0, recentLimit);
      saveRecentRecords();
    }

    function isExpanded(item) {
      if (!shared) return true;
      return recentView
        ? (recentPhotoVisibility.get(item.id) ?? recentShowRestricted)
        : (photoVisibility.get(item.id) ?? showRestricted);
    }

    function setExpanded(item, expanded) {
      if (recentView) {
        if (expanded === recentShowRestricted) recentPhotoVisibility.delete(item.id);
        else recentPhotoVisibility.set(item.id, expanded);
      } else if (expanded === showRestricted) {
        photoVisibility.delete(item.id);
      } else {
        photoVisibility.set(item.id, expanded);
      }
    }

    function replaceCatalog(next) {
      if (next !== null && (!next?.revision || !Array.isArray(next.images))) throw new Error('图包目录格式不正确。');
      const changed = catalog?.revision !== next?.revision;
      catalog = next;
      if (shared) modelLabels = new Map((next?.images || []).map(item => [item.id, novelAiModelLabel(item.model)]));
      if (changed) {
        selected.clear();
        photoVisibility.clear();
        recentPhotoVisibility.clear();
        originalDetails.clear();
        rating = defaultRating;
        showRestricted = false;
        recentShowRestricted = false;
        searchTerm = '';
        modelFilter = '';
        page = 0;
        postView = null;
        recentView = false;
        recentOrigin = null;
        listScroll = 0;
      }
      return changed;
    }

    function returnFromRecent() {
      const origin = recentOrigin;
      recentOrigin = null;
      recentView = false;
      if (!origin) return;
      byPost = origin.byPost;
      postView = origin.postView;
      searchTerm = origin.searchTerm;
      modelFilter = origin.modelFilter;
      page = Math.floor(origin.anchor / itemsPerPage());
      listScroll = origin.scroll;
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

    function showDetail(ordered, index) {
      const item = ordered[index];
      if (shared && isExpanded(item)) recordRecent(item);
      openScreen(`${packLabel} · 图片详情`, showList);
      const screen = screenRevision;
      const title = item.title || item.id;
      const frame = node('div', 'online-pack-detail-image');
      const facts = [shared ? modelLabels.get(item.id) : item.model, sections[item.section], item.source, sizeText(item.bytes)].filter(Boolean);
      const view = node('section', 'online-pack-detail');
      const original = button('查看完整原图', 'soft', () => {
        if (!isExpanded(item)) {
          setExpanded(item, true);
          recordRecent(item);
          showImage(showOriginal);
        } else {
          showImage(!showOriginal);
        }
      });
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
            back: () => showDetail(ordered, index),
            resourcePhoto: {
              title, label: packLabel, source: item.source || catalog.title,
              preview: image && image.className !== 'online-pack-image-pending' ? image : null,
            },
          });
        } catch (error) {
          if (screen !== screenRevision) return;
          toast(error?.message || '读取生成信息失败，请重试。');
          metadata.disabled = false;
          metadata.textContent = '查看提示词与参数';
        }
      });
      let gallerySaving = false;
      let galleryStored = false;
      const saveToGallery = button('存小预览和参数到图库', 'soft', () => transferGallery(false));
      const exportHtml = button('直接导出图文', 'soft', () => transferGallery(true));
      async function transferGallery(exportOnly) {
        if (saving || gallerySaving || (!exportOnly && galleryStored)) return;
        const activeScreen = screenRevision;
        gallerySaving = true;
        updateSave();
        try {
          const result = await native(exportOnly ? 'exportPackImageHtml' : 'saveOnlineToGallery', JSON.stringify({
            reference: item.original,
            name: title,
            label: packLabel,
            source: item.source || catalog.title,
            revision: catalog.revision,
            imageId: item.id,
          }));
          if (activeScreen !== screenRevision) return;
          if (exportOnly) {
            if (result === true) toast('已导出，可用浏览器打开或在文件应用分享');
            return;
          }
          if (!result || !result.id) throw new Error('没有收到图库保存结果。');
          galleryStored = result.promptCached === true;
          toast(galleryStored
            ? '已存小预览和生成信息到图库'
            : '已存小预览，但生成信息未能永久保存');
        } catch (error) {
          if (activeScreen === screenRevision) toast(error?.message || '保存到图库失败，请重试。');
        } finally {
          if (activeScreen === screenRevision) {
            gallerySaving = false;
            updateSave();
          }
        }
      }
      let showOriginal = originalDetails.has(item.id);
      let image = null;
      function showImage(full) {
        showOriginal = full;
        if (shared) {
          if (full) originalDetails.add(item.id);
          else originalDetails.delete(item.id);
        }
        if (!isExpanded(item)) {
          image = null;
          original.textContent = '展开这张图';
          frame.replaceChildren(node('span', 'online-pack-image-status', '已折叠'));
          return;
        }
        original.textContent = full ? '返回缩略图' : '查看完整原图';
        image = loadImage(frame, full ? item.original : item.thumbnail, title, !full, full ? () => {
          if (screen !== screenRevision) return;
          showImage(false);
          toast('原图读取失败，已切回缩略图。');
        } : null);
      }
      view.append(node('h2', '', title), node('p', 'online-pack-note', facts.join(' · ')), frame, original);
      if (shared && ordered.length > 1) {
        const nav = node('div', 'online-pack-pagination');
        const previous = button('上一张', 'soft', () => showDetail(ordered, index - 1));
        const next = button('下一张', 'soft', () => showDetail(ordered, index + 1));
        previous.disabled = index === 0;
        next.disabled = index === ordered.length - 1;
        nav.append(previous, node('span', 'online-pack-note', `${index + 1} / ${ordered.length} 张`), next);
        view.append(nav);
      }
      if (shared && /^https:\/\/arca\.live\/b\/aiart\/\d+$/.test(item.source)) {
        view.append(button('在浏览器打开原帖', 'text-button', () => openLink(item.source)));
      }
      body.append(view);
      showImage(showOriginal);
      actions.append(save, metadata, saveToGallery, exportHtml);
      bindSaveState(() => {
        save.disabled = saving || gallerySaving;
        save.textContent = saving ? '准备保存…' : saveLabel;
        saveToGallery.disabled = saving || gallerySaving || galleryStored;
        exportHtml.disabled = saving || gallerySaving;
        saveToGallery.textContent = galleryStored ? '已存到图库'
          : gallerySaving ? '正在存到图库…' : '存小预览和参数到图库';
      });
    }

    function tile(item, ordered) {
      const title = item.title || item.id;
      const card = node('article', 'online-pack-tile');
      const frame = node('span', 'online-pack-thumbnail');
      const open = button('', 'online-pack-open-photo', () => {
        if (!isExpanded(item)) { toggleImage(); return; }
        if (shared) listScroll = body.scrollTop;
        showDetail(ordered, ordered.indexOf(item));
      });
      const toggle = shared ? button('', 'text-button online-pack-tile-toggle', toggleImage) : null;
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
      caption.append(node('strong', '', title), node('span', 'online-pack-note', [shared ? modelLabels.get(item.id) : item.model, sections[item.section]].filter(Boolean).join(' · ')));
      open.append(frame, caption);
      label.append(checkbox, node('span', '', '选择'));
      if (toggle) {
        const controls = node('div', 'online-pack-tile-controls');
        controls.append(label, toggle);
        card.append(open, controls);
      } else {
        card.append(open, label);
      }

      function toggleImage() {
        setExpanded(item, !isExpanded(item));
        renderImage();
      }

      function renderImage() {
        const visible = isExpanded(item);
        open.setAttribute('aria-label', `${visible ? '查看' : '展开图片'} ${title}`);
        if (toggle) {
          const verb = visible ? '折叠' : '展开';
          toggle.textContent = verb;
          toggle.setAttribute('aria-label', `${verb} ${title}`);
          toggle.setAttribute('aria-pressed', String(visible));
        }
        if (visible) loadImage(frame, item.thumbnail, title, true);
        else frame.replaceChildren(node('span', 'online-pack-image-status', '已折叠'));
      }

      renderImage();
      return card;
    }

    function showList() {
      openScreen(packLabel, back);
      if (!window.Pocket) {
        body.append(node('p', 'online-pack-note', `请在安卓 App 中打开${packLabel}。`));
        return;
      }
      const screen = screenRevision;
      const source = node(shared || presetMode ? 'section' : 'details', 'online-pack-source');
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
      const importZip = button('选择画风 ZIP', 'primary compact', () => loadShared('importSharedStylePack'));
      const forgetZip = button('移除图包', 'soft compact', () => {
        if (confirm('移除 App 中的共享图包？手机原 ZIP 文件会保留。')) return loadShared('forgetSharedStylePack');
      });
      const retry = button(`重试读取${presetMode ? packLabel : '在线图包'}`, 'primary compact', () => loadCatalog(address, true));
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
        const description = remote ? '直接读取内置社区图包目录，图片按需加载。' : '支持社区画风合集和画风测试 ZIP，按需浏览包内图片。';
        source.append(node('p', 'online-pack-note', description), tools, searchField, status);
      } else if (presetMode) {
        source.append(node('p', 'online-pack-note', '这个远程图库入口会自动读取目录；图片按需加载，原图和提示词读取沿用在线图包缓存。'), status, retry);
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
        if (shared) {
          const grouping = node('div', 'segmented online-pack-filters');
          grouping.setAttribute('aria-label', '图库分组');
          for (const [grouped, label, recent] of [[false, '全部', false], [true, '按原帖', false], [false, '最近浏览', true]]) {
            const option = button(label, '', () => {
              if (recent) {
                if (recentView) return;
                recentOrigin = { byPost, postView, searchTerm, modelFilter, anchor: page * itemsPerPage(), scroll: body.scrollTop };
                recentView = true;
                postView = null;
                searchTerm = '';
                page = 0;
                renderCatalog();
                body.scrollTop = 0;
                return;
              }
              if (recentView) {
                returnFromRecent();
                if (byPost === grouped) {
                  renderCatalog();
                  body.scrollTop = listScroll;
                  return;
                }
              } else if (byPost === grouped && !postView) return;
              if (postView) searchTerm = postView.search;
              postView = null;
              byPost = grouped;
              page = 0;
              renderCatalog();
            });
            option.setAttribute('aria-pressed', String(recentView === recent && (recent || byPost === grouped)));
            grouping.append(option);
          }
          const controls = node('div', 'online-pack-view-controls');
          function setAll(expand) {
            if (recentView) {
              if (recentShowRestricted === expand && !recentPhotoVisibility.size) return;
              recentShowRestricted = expand;
              recentPhotoVisibility.clear();
            } else {
              if (showRestricted === expand && !photoVisibility.size) return;
              showRestricted = expand;
              photoVisibility.clear();
            }
            renderCatalog();
          }
          controls.append(button('全部展开', 'soft compact', () => setAll(true)),
            button('全部折叠', 'soft compact', () => setAll(false)));
          for (const count of [2, 3, 4]) {
            const option = button(`${count} 列`, 'chip', () => {
              if (columns === count) return;
              const anchor = page * itemsPerPage();
              columns = count;
              page = Math.floor(anchor / itemsPerPage());
              renderCatalog();
            });
            option.setAttribute('aria-pressed', String(columns === count));
            controls.append(option);
          }
          if (recentView) {
            controls.append(
              button('清除本图包记录', 'soft compact', () => {
                if (!confirm('清除本图包的最近浏览记录？')) return;
                const revision = String(catalog.revision);
                recentRecords = recentRecords.filter(record => record.mode !== mode || String(record.revision) !== revision);
                recentPhotoVisibility.clear();
                recentShowRestricted = false;
                page = 0;
                saveRecentRecords();
                renderCatalog();
                toast('已清除本图包最近浏览');
              }),
              button('返回原图库', 'soft compact', () => {
                returnFromRecent();
                renderCatalog();
                body.scrollTop = listScroll;
              }));
          }
          const models = [...new Set(modelLabels.values())].sort();
          const choices = [['', '全部模型']];
          for (const family of modelFamilies) {
            const variants = models.filter(model => model.startsWith(`${family} `) || model.startsWith(`${family}（`));
            if (!variants.length) continue;
            choices.push([family, `${family} · 全部型号`], ...variants.map(variant => [variant, variant]));
          }
          if (models.includes('未标注')) choices.push(['未标注', '模型未标注']);
          if (!choices.some(([value]) => value === modelFilter)) modelFilter = '';
          const modelSelect = options(choices, modelFilter);
          modelSelect.addEventListener('change', () => {
            modelFilter = modelSelect.value;
            page = 0;
            if (postView) postView = { ...postView, anchor: 0, scroll: 0 };
            renderCatalog();
            body.scrollTop = 0;
            content.querySelector('select')?.focus({ preventScroll: true });
          });
          content.append(grouping, field('按模型筛选', modelSelect),
            node('p', 'online-pack-note', '这些图片未分级，可能含成人内容。可逐张展开，也可一键展开或折叠图库。'), controls);
        } else {
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
        if (postView) {
          const context = node('div', 'online-pack-heading');
          const title = postView.id ? `原帖 ${postView.id}` : '原帖未标注';
          context.append(node('h3', '', title), button('返回全部帖子', 'soft compact', () => {
            const previous = postView;
            postView = null;
            searchTerm = previous.search;
            page = Math.floor(previous.anchor / itemsPerPage());
            renderCatalog();
            body.scrollTop = previous.scroll;
          }));
          view.append(context);
        }
        const query = searchTerm.normalize('NFKC').trim().toLowerCase();
        const imagesById = recentView ? new Map(catalog.images.map(item => [String(item.id), item])) : null;
        const filterFamily = modelFamilies.includes(modelFilter);
        const matches = item => {
          const model = modelLabels.get(item.id);
          const matchesModel = !modelFilter || model === modelFilter ||
            (filterFamily && (model.startsWith(`${modelFilter} `) || model.startsWith(`${modelFilter}（`)));
          return matchesModel && (!query || [item.title, item.id, item.postId, item.source]
            .some(value => String(value ?? '').normalize('NFKC').toLowerCase().includes(query)));
        };
        const images = shared
          ? (recentView
            ? currentRecentRecords().map(record => imagesById.get(record.imageId)).filter(item => item && matches(item))
            : catalog.images.filter(item => (!postView || String(item.postId ?? '') === postView.id) && matches(item)))
          : catalog.images.filter(item => item.rating === rating);
        const filtered = query || modelFilter;
        if (shared && filtered) view.append(node('p', 'online-pack-note', `找到 ${images.length} 张。`));
        if (!images.length) {
          const message = recentView
            ? (filtered ? '最近浏览中没有符合条件的图片。' : '这个图包还没有最近浏览记录。')
            : (shared ? '没有符合条件的图片。' : '这个分级暂时没有图片。');
          view.append(node('p', 'online-pack-note', message));
        } else if (!shared && rating === 'nsfw' && !showRestricted) {
          view.append(node('p', 'online-pack-note', `有 ${images.length} 张标注为 NSFW 的图片。`),
            button('显示 NSFW 图片', 'soft', () => { showRestricted = true; renderCatalog(); }));
        } else {
          const groups = shared && byPost && !postView && !recentView ? groupByPost(images) : null;
          const ordered = groups ? [...groups.values()].flat() : images;
          const capacity = itemsPerPage();
          const pages = Math.ceil(ordered.length / capacity);
          page = Math.min(page, pages - 1);
          const pageImages = ordered.slice(page * capacity, (page + 1) * capacity);
          function move(target) {
            if (target === page || target < 0 || target >= pages) return;
            page = target;
            listScroll = 0;
            renderCatalog();
            body.scrollTop = 0;
          }
          if (pages > 1) view.append(pageJump(page, pages, move));
          function grid(items) {
            const list = node('div', shared ? `online-pack-grid online-pack-columns-${columns}` : 'online-pack-grid');
            list.append(...items.map(item => tile(item, ordered)));
            return list;
          }
          if (groups) {
            for (const [id, items] of groupByPost(pageImages)) {
              const group = node('section', 'online-pack-post-group');
              const title = id ? `原帖 ${id}` : '原帖未标注';
              const heading = node('h3', '');
              const openPost = button(`${title} · ${groups.get(id).length} 张`, 'text-button', () => {
                postView = { id, anchor: page * capacity, search: searchTerm, scroll: body.scrollTop };
                page = 0;
                renderCatalog();
                body.scrollTop = 0;
              });
              openPost.setAttribute('aria-label', `只看${title}`);
              heading.append(openPost);
              group.append(heading, grid(items));
              view.append(group);
            }
          } else {
            view.append(grid(pageImages));
          }
          if (pages > 1) view.append(pageSteps(page, pages, move));
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
        const feedback = presetMode ? status : checking && !remote ? progress : status;
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
          } else if (customMode) {
            input.value = address = url;
            try { localStorage.setItem(addressKey, address); } catch { /* Browsing does not require storage. */ }
            source.open = false;
          } else {
            retry.hidden = true;
          }
          status.hidden = true;
          if (checking) toast(changed ? '图包目录已更新' : '图包目录已是最新');
        } catch (error) {
          if (screen !== screenRevision) return;
          const message = error?.message || '图包目录读取失败，请重试。';
          if (remote) {
            retry.hidden = false;
            status.textContent = message;
          } else if (presetMode) {
            retry.hidden = false;
            status.hidden = false;
            status.textContent = message;
            if (checking && catalog) toast(message);
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
      if (shared) body.scrollTop = listScroll;
      if (!catalog) {
        if (remote) loadCatalog();
        if (presetMode) loadCatalog(address);
      }
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
  window.showPresetOnlinePack = (pack, back = null) => {
    if (!pack || typeof pack !== 'object'
        || typeof pack.id !== 'string' || typeof pack.title !== 'string'
        || typeof pack.address !== 'string' || !pack.title.trim()) {
      toast('远程图库入口格式不正确。');
      return;
    }
    showPack(back, 'preset', {
      id: pack.id,
      title: pack.title.trim(),
      section: pack.section,
      address: pack.address.trim(),
      defaultRating: pack.defaultRating,
    });
  };
})();
