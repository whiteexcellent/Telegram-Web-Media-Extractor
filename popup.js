/**
 * Popup UI Controller
 * Renders discovered media, selection, scan progress, settings, and ZIP export
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    items: [],
    selected: new Set(),
    tab: 'dashboard',
    scanning: false,
    zipActive: false,
    chatName: '',
    previews: false,
    version: '?',
    retryManifest: null
  };

  const TYPE_ICONS = { photo: 'photo', video: 'video', gif: 'gif', animation: 'gif' };
  const number = new Intl.NumberFormat();
  const formatCount = value => number.format(value);
  let renderScheduled = false;

  function icon(name) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(element.namespaceURI, 'use');
    element.classList.add('icon');
    element.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#icon-' + name);
    element.appendChild(use);
    return element;
  }
  const TYPE_PREFIX = { photo: 'photo', video: 'video', gif: 'animation', animation: 'animation' };

  // thumbnail previews (small jpeg dataURLs from the page bridge)
  const thumbCache = new Map();     // itemId -> dataURL (filled by GET_MEDIA responses)
  const thumbImgRefs = new Map();   // itemId -> [img elements]
  const thumbRequested = new Set();
  const thumbQueue = [];
  let thumbActiveCount = 0;
  const THUMB_CONCURRENT = 3;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    $('appVersion').textContent = `v${chrome.runtime.getManifest().version}`;
    setupNav();
    setupToolbar();
    setupZipControls();
    setupSettings();
    setupBroadcastListener();
    refreshEverything();
  }

  /* ---------------- messaging helpers ---------------- */

  function send(type, data) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, data }, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function setupBroadcastListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'MEDIA_UPDATE':
          state.items = msg.data?.items || [];
          {
            const ded = msg.data?.stats?.deduped || 0;
            const prev = state.lastDeduped || 0;
            if (ded > prev) toast(`${formatCount(ded - prev)} duplicate items filtered`);
            state.lastDeduped = Math.max(prev, ded);
          }
          if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(() => {
              renderScheduled = false;
              renderEverything();
            });
          }
          break;
        case 'SCAN_STATUS':
          onScanStatus(msg.data || {});
          break;
        case 'DOWNLOAD_PROGRESS':
          onDownloadProgress(msg.data || {});
          break;
        case 'ZIP_READY':
          toast(msg.data?.filename || 'ZIP saved');
          break;
      }
    });
  }

  async function refreshEverything() {
    const [chatInfo] = await Promise.all([
      send('GET_CHAT_INFO'),
      loadMedia()
    ]);
    const connected = ['K', 'A'].includes(chatInfo?.version);
    state.chatName = connected ? chatInfo.chatName || 'Telegram chat' : '';
    state.version = connected ? chatInfo.version : '?';
    $('chatName').textContent = state.chatName || 'Open a chat on Telegram Web';
    $('chatInfo').classList.toggle('connected', connected);
    $('versionLabel').hidden = !connected;
    $('versionLabel').textContent = connected ? `Web ${state.version}` : '';
    const status = await send('GET_STATUS');
    if (status?.scanning) onScanStatus({ scanning: true, progress: status.scanProgress });
    if (status?.downloadState?.phase) onDownloadProgress(status.downloadState);
    renderEverything();
  }

  async function loadMedia() {
    const resp = await send('GET_MEDIA');
    if (resp?.items) state.items = resp.items;
    pruneSelection();
  }

  function isDownloadable(item) {
    return Boolean(item.url);
  }

  function pruneSelection() {
    const eligible = new Set(state.items.filter(isDownloadable).map(item => item.id));
    for (const id of state.selected) {
      if (!eligible.has(id)) state.selected.delete(id);
    }
  }

  /* ---------------- navigation ---------------- */

  function setupNav() {
    $('btnBrowse').addEventListener('click', () => switchTab('all'));
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    $('workspace').scrollTop = 0;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    document.querySelectorAll('.section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `sec-${tab}`);
    });
    renderCurrentTab();
  }

  function renderCurrentTab() {
    thumbImgRefs.clear();
    switch (state.tab) {
      case 'photos':
        renderGrid($('gridPhotos'), $('emptyPhotos'), byType('photo'));
        break;
      case 'videos':
        renderGrid($('gridVideos'), $('emptyVideos'), byType('video'));
        break;
      case 'gifs':
        renderGrid($('gridGifs'), $('emptyGifs'), byType('gif', 'animation'));
        break;
      case 'all':
        renderList($('listAll'), $('emptyAll'), state.items);
        break;
      case 'zip':
        renderZipSummary();
        break;
      default:
        renderDashboard();
    }
  }

  function byType(...types) {
    return state.items.filter((i) => types.includes(i.type));
  }

  /* ---------------- rendering ---------------- */

  function renderEverything() {
    pruneSelection();
    renderDashboard();
    renderCounts();
    renderCurrentTab();
    updateFooter();
  }

  function renderDashboard() {
    const stats = getStats();
    $('statPhotos').textContent = formatCount(stats.photos);
    $('statVideos').textContent = formatCount(stats.videos);
    $('statGifs').textContent = formatCount(stats.gifs);
    $('statTotal').textContent = formatCount(stats.total);
    $('statProtected').textContent = formatCount(stats.protectedCount);
    const loaded = state.items.filter(isDownloadable).length;
    $('overviewHint').textContent = stats.total
      ? `${formatCount(loaded)} ready to export${stats.total > loaded ? ` · ${formatCount(stats.total - loaded)} waiting to load` : ''}`
      : 'Scan an open Telegram chat to discover media.';
  }

  function getStats() {
    return {
      total: state.items.length,
      photos: state.items.filter(i => i.type === 'photo').length,
      videos: state.items.filter(i => i.type === 'video').length,
      gifs: state.items.filter(i => i.type === 'gif' || i.type === 'animation').length,
      protectedCount: state.items.filter(i => i.isProtected).length
    };
  }

  function renderCounts() {
    const stats = getStats();
    $('navPhotos').textContent = formatCount(stats.photos);
    $('navVideos').textContent = formatCount(stats.videos);
    $('navGifs').textContent = formatCount(stats.gifs);
    $('navAll').textContent = formatCount(stats.total);
  }

  function renderCollection(container, empty, items, build) {
    const focusId = container.contains(document.activeElement) ? document.activeElement.dataset.mediaId : '';
    const fragment = document.createDocumentFragment();
    let restoreFocus;
    for (const item of items) {
      const element = build(item);
      if (item.id === focusId) restoreFocus = element;
      fragment.appendChild(element);
    }
    empty.hidden = Boolean(items.length);
    container.replaceChildren(fragment);
    restoreFocus?.focus({ preventScroll: true });
  }

  function renderGrid(grid, empty, items) {
    renderCollection(grid, empty, items, buildCard);
  }

  function mediaButton(item, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.mediaId = item.id;
    button.disabled = !isDownloadable(item);
    button.setAttribute('aria-label', displayName(item) + (item.isProtected ? ', marked as protected by Telegram' : ''));
    reflectSelection(button);
    button.addEventListener('click', () => {
      if (state.selected.has(item.id)) state.selected.delete(item.id);
      else state.selected.add(item.id);
      syncSelectionUI();
    });
    return button;
  }

  function reflectSelection(button) {
    const selected = state.selected.has(button.dataset.mediaId);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }

  function buildCard(item) {
    const card = mediaButton(item, 'media-card');
    card.appendChild(thumbFor(item));

    const check = document.createElement('span');
    check.className = 'checkbox';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    card.appendChild(check);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = badgeFor(item);
    card.appendChild(badge);

    if (item.isProtected) {
      const lock = document.createElement('span');
      lock.className = 'protected-chip';
      lock.appendChild(icon('lock'));
      card.appendChild(lock);
    }
    card.title = item.url ? displayName(item) : 'Open this GIF in Telegram to load it';
    return card;
  }

  function thumbFor(item) {
    const host = document.createElement('span');
    host.className = 'thumb-host';
    if (!state.previews) {
      host.appendChild(placeholderFor(item));
      return host;
    }
    const cached = thumbCache.get(item.id) || item.thumbDataUrl;
    if (cached) {
      thumbCache.set(item.id, cached);
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.src = cached;
      host.appendChild(img);
      return host;
    }

    const src = item.thumbnailUrl || '';
    const httpSrc = typeof src === 'string' && /^https?:/.test(src) ? src : '';
    if (httpSrc) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.src = httpSrc;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        const replacement = placeholderFor(item);
        img.replaceWith(replacement);
        registerThumbImg(item.id, replacement);
      }, { once: true });
      host.appendChild(img);
      registerThumbImg(item.id, img);
    } else {
      const ph = placeholderFor(item);
      host.appendChild(ph);
      registerThumbImg(item.id, ph); // replaced when preview arrives
    }
    enqueueThumb(item);
    return host;
  }

  function registerThumbImg(id, el) {
    if (!thumbImgRefs.has(id)) thumbImgRefs.set(id, []);
    const list = thumbImgRefs.get(id);
    // drop removed elements
    thumbImgRefs.set(id, list.filter((e) => e.isConnected));
    thumbImgRefs.get(id).push(el);
  }

  function enqueueThumb(item) {
    if (!item.url || thumbRequested.has(item.id) || item.type === 'unknown') return;
    // initial items render is async on purpose — debounce is handled by the queue
    if (thumbQueue.length > 160) return;
    thumbRequested.add(item.id);
    thumbQueue.push(item.id);
    setTimeout(pumpThumbs, 60);
  }

  async function pumpThumbs() {
    if (thumbActiveCount >= THUMB_CONCURRENT) return;
    const id = thumbQueue.shift();
    if (!id) return;
    thumbActiveCount++;
    try {
      const resp = await send('GET_MEDIA_THUMB', { id });
      if (state.previews && resp?.ok && resp.dataUrl) {
        thumbCache.set(id, resp.dataUrl);
        for (const el of thumbImgRefs.get(id) || []) {
          const img = el.tagName === 'IMG' ? el : document.createElement('img');
          img.className = 'thumb';
          img.alt = '';
          img.src = resp.dataUrl;
          if (el.tagName !== 'IMG') el.replaceWith(img);
        }
      }
    } catch {}
    thumbActiveCount--;
    if (thumbQueue.length) pumpThumbs();
  }

  function placeholderFor(item) {
    const el = document.createElement('span');
    el.className = 'thumb-placeholder';
    el.appendChild(icon(TYPE_ICONS[item.type] || 'grid'));
    return el;
  }

  function badgeFor(item) {
    if (item.type === 'gif' || item.type === 'animation') return item.url ? 'GIF' : 'GIF · Not loaded';
    if (item.type === 'video' && item.duration && isFinite(item.duration)) {
      const total = Math.round(item.duration);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    if (item.width > 0 && item.height > 0) return `${item.width}×${item.height}`;
    return (item.ext || '').toUpperCase() || 'FILE';
  }

  function renderList(list, empty, items) {
    renderCollection(list, empty, items, buildListRow);
  }

  function buildListRow(item) {
    const row = mediaButton(item, 'media-list-item');
    const thumb = document.createElement('span');
    thumb.className = 'list-thumb';
    thumb.appendChild(thumbFor(item));
    row.appendChild(thumb);

    const info = document.createElement('span');
    info.className = 'list-info';
    const name = document.createElement('span');
    name.className = 'list-name';
    name.textContent = displayName(item);

    const meta = document.createElement('span');
    meta.className = 'list-meta';
    const details = [item.type === 'gif' || item.type === 'animation' ? 'GIF' : item.type];
    if (item.size) details.push(formatFileSize(item.size));
    if (item.isProtected) details.push('Marked protected');
    if (!item.url) details.push('Open in Telegram to load');
    meta.textContent = details.join(' · ');
    info.append(name, meta);
    row.appendChild(info);

    const check = document.createElement('span');
    check.className = 'list-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    row.appendChild(check);
    return row;
  }

  function displayName(item) {
    const prefix = TYPE_PREFIX[item.type] || 'media';
    const mid = String(item.messageId || '').slice(-6);
    const w = item.width > 0 ? `_${item.width}x${item.height}` : '';
    return `${prefix}_${mid}${w}.${item.ext || 'bin'}`;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  /* ---------------- toolbar ---------------- */

  function setupToolbar() {
    $('btnScan').addEventListener('click', async () => {
      if (state.scanning) {
        await send('STOP_SCAN');
        return;
      }
      onScanStatus({ scanning: true });
      const resp = await send('START_SCAN', { direction: 'up' });
      if (!resp?.started) {
        onScanStatus({ scanning: false, progress: { status: 'error' } });
        toast(resp?.error || 'Open a Telegram Web chat before scanning');
      }
    });

    $('btnSelectAll').addEventListener('click', () => {
      for (const item of state.items) {
        if (isDownloadable(item)) state.selected.add(item.id);
      }
      syncSelectionUI();
    });

    $('btnSelectNone').addEventListener('click', () => {
      state.selected.clear();
      syncSelectionUI();
    });

    $('btnDownloadZip').addEventListener('click', () => switchTab('zip'));
  }

  function syncSelectionUI() {
    document.querySelectorAll('[data-media-id]').forEach(reflectSelection);
    updateFooter();
    renderZipSummary();
  }

  function updateFooter(statusText) {
    $('footerSelected').textContent = `${formatCount(state.selected.size)} selected`;
    $('btnSelectNone').disabled = !state.selected.size;
    $('btnSelectAll').disabled = !state.items.some(isDownloadable);
    if (statusText) $('footerStatus').textContent = statusText;
  }

  function onScanStatus(data) {
    state.scanning = Boolean(data.scanning);
    const progress = data.progress || {};
    $('scanStatusCard').hidden = !state.scanning;
    $('scanLabel').textContent = state.scanning ? 'Stop scan' : 'Scan chat';
    $('scanIcon').setAttribute('href', state.scanning ? '#icon-stop' : '#icon-scan');

    if (state.scanning) {
      $('scanStatusText').textContent = `${formatCount(progress.scanned || 0)} screens scanned · ${formatCount(progress.found || 0)} items found`;
      updateFooter('Scanning chat…');
    } else {
      updateFooter(scanStatusText(progress.status));
      loadMedia().then(renderEverything);
    }
    renderZipSummary();
  }

  function scanStatusText(status) {
    const map = {
      no_scroll_container: 'No scrollable chat found — open a chat first',
      reached_top: 'Reached top of chat',
      reached_bottom: 'Reached bottom of chat',
      no_new_media: 'No additional media found',
      stopped: 'Scan stopped',
      error: 'Scan failed'
    };
    return map[status] || 'Scan finished';
  }

  /* ---------------- ZIP export ---------------- */

  function setupZipControls() {
    $('btnCreateZip').addEventListener('click', () => startZip());
    $('retryManifest').addEventListener('change', loadRetryManifest);
    $('btnRetryFailed').addEventListener('click', () => startZip(retryItems().map(item => item.id), true));
    chrome.storage.local.get('retryManifest').then(({ retryManifest }) => {
      state.retryManifest = retryManifest || null;
      renderRetry();
    }).catch(() => {});

    $('btnAddUrl').addEventListener('click', addDirectUrlFromInput);
    $('directUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addDirectUrlFromInput();
    });
  }

  function retryKey(type, id) {
    const normalized = type === 'animation' ? 'gif' : type;
    return ['photo', 'video', 'gif'].includes(normalized) && id
      ? JSON.stringify([normalized, String(id)]) : '';
  }

  async function loadRetryManifest(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const manifest = JSON.parse(await file.text());
      if (!Array.isArray(manifest.errors)) throw new Error('Invalid ZIP manifest');
      const keys = new Set();
      let missingId = 0;
      for (const entry of manifest.errors) {
        const key = retryKey(entry?.type, entry?.messageId);
        if (key) keys.add(key);
        else missingId++;
      }
      state.retryManifest = { keys: [...keys], missingId };
      await chrome.storage.local.set({ retryManifest: state.retryManifest });
      renderRetry();
    } catch {
      toast('Could not read the ZIP manifest');
    }
  }

  function retryItems() {
    const keys = new Set(state.retryManifest?.keys || []);
    return state.items.filter(item => isDownloadable(item) && (
      keys.has(retryKey(item.type, item.messageId)) ||
      (item.documentId && keys.has(retryKey(item.type, 'stream_' + item.documentId)))
    ));
  }

  function renderRetry() {
    if (!state.retryManifest) return;
    const matches = retryItems().length;
    const { keys, missingId } = state.retryManifest;
    $('btnRetryFailed').disabled = !matches || state.scanning || state.zipActive;
    $('retryStatus').textContent = `${formatCount(matches)} loaded items match ${formatCount(keys.length)} failed message IDs` +
      (missingId ? ` · ${missingId} errors have no usable message ID` : '');
  }

  async function addDirectUrlFromInput() {
    const input = $('directUrl');
    const url = (input.value || '').trim();
    if (!url) {
      toast('Paste a media URL first');
      return;
    }
    const resp = await send('ADD_DIRECT_URL', { url });
    if (resp?.error) {
      toast(resp.error);
      return;
    }
    input.value = '';
    await loadMedia();
    const item = state.items.find(item => item.id === resp?.item?.id);
    if (item && isDownloadable(item)) state.selected.add(item.id);
    switchTab('all');
    renderEverything();
    toast('Media is in the list');
  }

  async function startZip(ids = zipItems().map(item => item.id), retry = false) {
    if (state.zipActive) {
      toast('ZIP already in progress');
      return;
    }
    if (state.scanning) {
      toast('Wait for the scan to finish');
      return;
    }
    if (!ids.length) {
      toast('No loaded media selected');
      return;
    }

    state.zipActive = true;
    switchTab('zip');
    setZipVisible(true);
    resetBars();
    progressDetail('Preparing the export…');

    const resp = await send('START_ZIP_DOWNLOAD', { mediaIds: ids, retry });
    if (!resp?.started) {
      state.zipActive = false;
      setZipVisible(false);
      renderZipSummary();
      toast(resp?.error || 'Could not start the ZIP export');
    }
  }

  function zipItems() {
    return state.items.filter(item => isDownloadable(item) && (!state.selected.size || state.selected.has(item.id)));
  }

  function renderZipSummary() {
    renderRetry();
    const source = zipItems();
    const count = (t) => source.filter((i) => t.includes(i.type)).length;
    const photos = count(['photo']);
    const videos = count(['video']);
    const gifs = count(['gif', 'animation']);
    const size = source.reduce((acc, i) => acc + (i.size || 0), 0);

    $('zipPhotos').textContent = formatCount(photos);
    $('zipVideos').textContent = formatCount(videos);
    $('zipGifs').textContent = formatCount(gifs);
    $('zipTotal').textContent = formatCount(source.length);
    $('zipSize').textContent = size > 0 ? formatFileSize(size) : '—';

    $('btnCreateZip').disabled = !source.length || state.scanning || state.zipActive;
  }

  function onDownloadProgress(data) {
    const phase = data.phase || '';
    setZipVisible(true);
    $('zipProgress').dataset.phase = phase;
    state.zipActive = ['preparing', 'downloading', 'zipping'].includes(phase);
    const d = data;

    if (phase === 'preparing' || phase === 'downloading') {
      state.zipActive = true;
      const pct = `${d.progress || 0}%`;
      $(`barDown`).style.width = pct;
      $(`phaseDown`).textContent = pct;
    } else if (phase === 'zipping') {
      state.zipActive = true;
      $('barDown').style.width = '100%';
      $('phaseDown').textContent = '100%';
      $('barZip').style.width = `${d.progress || 0}%`;
      $('phaseZip').textContent = `${d.progress || 0}%`;
    } else if (phase === 'complete') {
      $('barDown').style.width = '100%';
      $('barZip').style.width = '100%';
      $('phaseDown').textContent = '100%';
      $('phaseZip').textContent = '100%';
      state.zipActive = false;
      updateFooter('Ready');
    } else if (phase === 'error') {
      state.zipActive = false;
      updateFooter('Export failed');
    }
    if (state.zipActive) updateFooter(phase === 'zipping' ? 'Packaging ZIP…' : 'Downloading media…');
    progressDetail(d.details || '');
    renderZipSummary();
  }

  function setZipVisible(vis) {
    $('zipProgress').hidden = !vis;
  }

  function resetBars() {
    $('barDown').style.width = '0%';
    $('barZip').style.width = '0%';
    $('phaseDown').textContent = '0%';
    $('phaseZip').textContent = '0%';
  }

  function progressDetail(text) {
    $('progressDetail').textContent = text;
  }

  /* ---------------- settings ---------------- */

  const SETTINGS = { concurrent: 4, autoDetect: true, thumbnails: false };

  function setupSettings() {
    chrome.storage.local.get(Object.keys(SETTINGS)).then((stored) => {
      const concurrent = stored.concurrent ?? SETTINGS.concurrent;
      const autoDetect = stored.autoDetect ?? SETTINGS.autoDetect;
      const thumbnails = stored.thumbnails ?? SETTINGS.thumbnails;

      $('setConcurrent').value = String(Math.min(5, Math.max(2, concurrent)));
      $('setAutoDetect').checked = !!autoDetect;
      state.previews = !!thumbnails;
      $('setThumbnails').checked = state.previews;
      renderCurrentTab();
    }).catch(() => {});

    $('setConcurrent').addEventListener('change', (e) => {
      chrome.storage.local.set({ concurrent: parseInt(e.target.value, 10) || 4 });
      toast('Settings saved');
    });

    for (const id of ['setAutoDetect', 'setThumbnails']) {
      $(id).addEventListener('change', (e) => {
        chrome.storage.local.set({ [id === 'setAutoDetect' ? 'autoDetect' : 'thumbnails']: e.target.checked });
        if (id === 'setThumbnails') {
          state.previews = e.target.checked;
          if (!state.previews) {
            thumbQueue.length = 0;
            thumbRequested.clear();
            thumbCache.clear();
          }
          renderCurrentTab();
        }
        toast('Settings saved');
      });
    }

    $('btnClear').addEventListener('click', async () => {
      await send('CLEAR_MEDIA');
      state.selected.clear();
      state.items = [];
      renderEverything();
      toast('Detected media list cleared');
    });
  }

  /* ---------------- toast ---------------- */

  function toast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }
})();
