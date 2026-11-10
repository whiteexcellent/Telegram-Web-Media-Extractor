import './modules/photo-fingerprint.js';

/**
 * Background Service Worker
 * Coordinates between content script, popup, and offscreen document
 */

let mediaStore = new Map();
const photoVisuals = new Map();
let scanState = { scanning: false, progress: {} };
let downloadState = { active: false, phase: '', progress: 0, details: '' };
let offscreenReady = false;
let pendingDownloads = new Map(); // itemId -> { chunks: Map<int,Array>, resolve, reject, timer }
let thumbCache = new Map();       // itemId -> small JPEG dataURL (LRU-capped)
const THUMB_CACHE_MAX = 240;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse);
  return true;
});

async function handleMessage(msg, sender, sendResponse) {
  try {
    switch (msg.type) {
      case 'MEDIA_DETECTED': {
        const items = msg.data?.items || [];
        for (const item of items) {
          storeMedia(item);
        }
        broadcastToPopup('MEDIA_UPDATE', {
          items: visibleMedia(),
          stats: getStats()
        });
        sendResponse({ received: items.length });
        break;
      }
      case 'MEDIA_REMOVED': {
        const ids = new Set(msg.data?.ids || []);
        let changed = false;
        for (const id of ids) {
          if (mediaStore.delete(id)) changed = true;
          thumbCache.delete(id);
          photoVisuals.delete(id);
        }
        if (changed) {
          broadcastToPopup('MEDIA_UPDATE', {
            items: visibleMedia(),
            stats: getStats()
          });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'MEDIA_FINGERPRINT': {
        const { id, url, key, visual } = msg.data || {};
        const item = mediaStore.get(id);
        if (item?.url === url && (key || visual)) {
          if (key) item.contentKey = key;
          recordPhotoVisual(item, visual);
          broadcastToPopup('MEDIA_UPDATE', { items: visibleMedia(), stats: getStats() });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'SCAN_PROGRESS': {
        scanState.scanning = true;
        scanState.progress = msg.data;
        broadcastToPopup('SCAN_STATUS', { scanning: true, progress: msg.data });
        sendResponse({ ok: true });
        break;
      }
      case 'SCAN_COMPLETE': {
        scanState.scanning = false;
        scanState.progress = msg.data;
        broadcastToPopup('SCAN_STATUS', { scanning: false, progress: msg.data });
        sendResponse({ ok: true });
        break;
      }
      case 'START_SCAN': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error('Open a Telegram Web chat before scanning');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_CHAT', data: msg.data || {} });
        sendResponse(response || { error: 'Open a Telegram Web chat before scanning' });
        break;
      }
      case 'STOP_SCAN': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'STOP_SCANNING' });
        }
        scanState.scanning = false;
        sendResponse({ stopped: true });
        break;
      }
      case 'GET_MEDIA': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_MEDIA' });
            if (response?.items) {
              for (const item of response.items) storeMedia(item);
            }
          } catch {}
        }
        const filter = msg.data?.filter;
        let items = visibleMedia();
        if (filter && filter !== 'all') {
          items = items.filter(i => i.type === filter);
        }
        // attach cached previews (small jpeg dataURLs)
        items = items.map(it => thumbCache.has(it.id)
          ? { ...it, thumbDataUrl: thumbCache.get(it.id) }
          : it);
        sendResponse({ items, stats: getStats() });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({
          scanning: scanState.scanning,
          scanProgress: scanState.progress,
          downloadState,
          stats: getStats(),
          mediaCount: mediaStore.size
        });
        break;
      }
      case 'GET_CHAT_INFO': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CHAT_INFO' });
            sendResponse(response);
          } catch {
            sendResponse({ chatName: 'Unknown', version: '?', url: '' });
          }
        } else {
          sendResponse({ chatName: 'Unknown', version: '?', url: '' });
        }
        break;
      }
      case 'START_ZIP_DOWNLOAD': {
        handleZipDownload(msg.data?.mediaIds, sendResponse, msg.data?.retry === true);
        break;
      }
      case 'ADD_DIRECT_URL': {
        sendResponse(addDirectUrl(msg.data?.url || ''));
        break;
      }
      case 'GET_MEDIA_THUMB': {
        try {
          const id = msg.data?.id || '';
          // Tab-side bridge has a limit of ~288px, keeping LRU memory below cap
          while (thumbCache.size >= THUMB_CACHE_MAX) {
            thumbCache.delete(thumbCache.keys().next().value);
          }
          const resp = thumbCache.has(id) ? { ok: true, dataUrl: thumbCache.get(id) } : null;
          if (resp) {
            sendResponse(resp);
            break;
          }
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) {
            sendResponse({ ok: false, error: 'No active tab' });
            break;
          }
          const thumb = await chrome.tabs.sendMessage(tab.id, {
            type: 'GET_ITEM_THUMB',
            data: { id }
          });
          if (thumb?.ok && thumb.dataUrl) {
            thumbCache.set(id, thumb.dataUrl);
          }
          sendResponse(thumb || { ok: false, error: 'No thumb' });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'CLEAR_MEDIA': {
        mediaStore.clear();
        photoVisuals.clear();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          try { chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_MEDIA' }); } catch {}
        }
        broadcastToPopup('MEDIA_UPDATE', { items: [], stats: getStats() });
        sendResponse({ cleared: true });
        break;
      }
      case 'PING': {
        sendResponse({ alive: true });
        break;
      }
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

function storeMedia(item) {
  const { visualFingerprint, ...media } = item;
  const previous = mediaStore.get(item.id);
  if (previous?.url !== item.url || item.type !== 'photo') photoVisuals.delete(item.id);
  mediaStore.set(item.id, {
    ...media,
    isProtected: Boolean(previous?.isProtected || item.isProtected),
    contentKey: item.contentKey || (previous?.url === item.url ? previous.contentKey : '')
  });
  recordPhotoVisual(media, visualFingerprint);
}

function recordPhotoVisual(item, fingerprint) {
  if (item.type !== 'photo' || photoVisuals.has(item.id)) return;
  const visual = globalThis.TMEPhotoFingerprint.decode(fingerprint);
  if (!visual) return;
  let group = item.id;
  for (const existing of photoVisuals.values()) {
    if (globalThis.TMEPhotoFingerprint.matches(existing, visual)) {
      group = existing.group;
      break;
    }
  }
  photoVisuals.set(item.id, { ...visual, group });
}

function visibleMedia() {
  const byUrl = new Map();
  for (const item of mediaStore.values()) {
    const key = item.streamKey || item.url || item.id;
    const existing = byUrl.get(key);
    if (!existing || (!existing.isProtected && item.isProtected)) byUrl.set(key, item);
  }
  const byContent = new Set();
  const byVisual = new Set();
  return Array.from(byUrl.values()).filter(item => {
    const visualGroup = photoVisuals.get(item.id)?.group;
    const duplicate = byContent.has(item.contentKey) || byVisual.has(visualGroup);
    if (item.contentKey) byContent.add(item.contentKey);
    if (visualGroup) byVisual.add(visualGroup);
    return !duplicate;
  });
}

function findVisibleMedia(id, url) {
  const existing = mediaStore.get(id) || Array.from(mediaStore.values()).find(item => (item.url === url || item.streamKey === id));
  if (!existing) return null;
  const visualGroup = photoVisuals.get(existing.id)?.group;
  return visibleMedia().find(item => item.id === existing.id || item.url === url || (existing.streamKey && item.streamKey === existing.streamKey) ||
    (existing.contentKey && existing.contentKey === item.contentKey) ||
    (visualGroup && visualGroup === photoVisuals.get(item.id)?.group));
}

function getStats() {
  const items = visibleMedia();
  return {
    total: items.length,
    photos: items.filter(i => i.type === 'photo').length,
    videos: items.filter(i => i.type === 'video').length,
    gifs: items.filter(i => i.type === 'gif' || i.type === 'animation').length,
    protectedCount: items.filter(i => i.isProtected).length,
    downloadable: items.filter(i => i.url).length,
    deduped: mediaStore.size - items.length
  };
}

/* ---------------- direct URL ---------------- */

function hashDjb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* Pure (no-DOM) /stream/ metadata parser — mirrors content-side parser */
function parseStreamMetaFromUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return null; }
  if (!/\/(?:web)?stream/i.test(parsed.pathname)) return null;

  const params = parsed.searchParams;
  let json = null;
  for (const key of ['location', 'file', 'meta', 'metadata', 'script']) {
    const raw = params.get(key);
    if (!raw) continue;
    try { json = JSON.parse(raw); } catch {}
    if (json && typeof json === 'object') break;
    json = null;
  }
  if (!json) {
    const m = parsed.pathname.match(/\/(?:web)?stream\/(.+)$/i);
    if (m && m[1]) {
      try {
        let dec = decodeURIComponent(m[1]);
        if (/%7[Bb]/.test(dec.slice(0, 3))) {
          try { dec = decodeURIComponent(dec); } catch {}
        }
        json = JSON.parse(dec);
      } catch {
        json = null;
      }
    }
  }
  return { json, params };
}

function addDirectUrl(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return { error: 'URL required' };
  if (!/^(https?:\/\/|blob:)/i.test(url)) return { error: 'Only http(s) or blob: URLs are supported' };

  /* Web K stream shape: /k/stream/%7B%22dcId%22...%7D (JSON in the path) */
  if (!url.startsWith('blob:')) {
    const meta = parseStreamMetaFromUrl(url);
    if (meta) {
      const { json, params } = meta;
      const mime = params.get('mime') || params.get('mimeType') ||
        params.get('mime_type') || params.get('content_type') ||
        (json && (json.mimeType || json.mime || json.content_type)) || '';
      const size = parseInt(params.get('size') || '', 10) ||
        parseInt((json && json.size) || '', 10) || 0;
      const dcId = params.get('dcId') ||
        (json && json.dcId != null ? String(json.dcId) : '');
      const locationId = params.get('location.id') ||
        (json && json.location && json.location.id != null
          ? String(json.location.id) : '') ||
        (json && json.id != null ? String(json.id) : '') || '';

      let type = 'video';
      if (mime.startsWith('image/gif')) type = 'gif';
      else if (mime.startsWith('image/')) type = 'photo';

      let ext = '';
      if (mime) {
        ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
          'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm',
          'video/quicktime': 'mov', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' })[mime] || '';
      }
      if (!ext) {
        const fn = (json && (json.fileName || json.filename)) || '';
        ext = (decodeURIComponent(fn).match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || 'mp4';
      }

      const id = `tme_stream_${dcId}_${locationId || hashDjb2(url)}`;
      const existing = findVisibleMedia(id, url);
      if (existing) return { ok: true, item: existing, exists: true };

      const item = {
        id,
        type,
        url,
        thumbnailUrl: '',
        filename: (json && (json.fileName || json.filename)) || '',
        size,
        date: new Date().toISOString(),
        messageId: `stream_${locationId || Date.now().toString(36)}`,
        chatName: '',
        mimeType: mime,
        isProtected: false,
        width: 0,
        height: 0,
        duration: 0,
        ext,
        source: 'stream',
        streamKey: locationId ? id : ''
      };
      mediaStore.set(id, item);
      broadcastToPopup('MEDIA_UPDATE', { items: visibleMedia(), stats: getStats() });
      return { ok: true, item };
    }
  }

  let mime = '';
  let size = 0;
  let type = 'video';
  let locationId = '';
  let ext = '';
  try {
    const u = new URL(url);
    const p = u.searchParams;
    mime = p.get('mime') || p.get('mimeType') || p.get('mime_type') ||
           p.get('content_type') || '';
    size = parseInt(p.get('size') || '', 10) || 0;
    locationId = p.get('location.id') || '';
    if (mime.startsWith('image/gif')) type = 'gif';
    else if (mime.startsWith('image/')) type = 'photo';
    else if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'video';
    else if (/\.(jpe?g|png|webp)$/i.test(u.pathname)) type = 'photo';
    else if (/\.gif$/i.test(u.pathname)) type = 'gif';
    const mimeExt = ({
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm',
      'video/quicktime': 'mov', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3'
    })[mime];
    ext = mimeExt ||
      (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()) ||
      'mp4';
  } catch {
    // blob: URL without query params
    ext = 'bin';
  }

  const id = `tme_direct_${hashDjb2(url)}`;
  const existing = findVisibleMedia(id, url);
  if (existing) return { ok: true, item: existing, exists: true };

  const item = {
    id,
    type,
    url,
    thumbnailUrl: '',
    filename: '',
    size,
    date: new Date().toISOString(),
    messageId: locationId ? `direct_${locationId}` : `direct_${Date.now().toString(36)}`,
    chatName: '',
    mimeType: mime,
    isProtected: false,
    width: 0,
    height: 0,
    duration: 0,
    ext,
    source: 'direct'
  };
  mediaStore.set(id, item);
  broadcastToPopup('MEDIA_UPDATE', { items: visibleMedia(), stats: getStats() });
  return { ok: true, item };
}

function safeExportError(error) {
  return String(error || 'Media fetch failed')
    .replace(/(?:blob:)?https?:\/\/[^\s"'<>]+/gi, '[media URL]');
}

async function handleZipDownload(mediaIds, sendResponse, retry) {
  if (downloadState.active) {
    sendResponse({ error: 'A ZIP download is already running' });
    return;
  }
  const selected = Array.isArray(mediaIds) ? new Set(mediaIds) : null;
  const items = visibleMedia().filter(item => item.url && (!selected || selected.has(item.id)));
  if (!items.length) {
    sendResponse({ error: 'No loaded media selected' });
    return;
  }

  downloadState = { active: true, phase: 'preparing', progress: 0, details: 'Preparing download...' };
  broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
  sendResponse({ started: true, totalFiles: items.length });

  try {
    await ensureOffscreen();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    await sendOffscreenMessage('OFFSCREEN_START_ZIP', { totalFiles: items.length });

    let MAX_CONCURRENT = 4;
    try {
      const { concurrent } = await chrome.storage.local.get('concurrent');
      MAX_CONCURRENT = Math.min(5, Math.max(1, parseInt(concurrent, 10) || 4));
    } catch {}
    const RETRY_COUNT = 3;
    const RETRY_DELAY = 2000;
    const downloadedFiles = [];
    const failures = [];
    let completed = 0;
    const total = items.length;

    downloadState.phase = 'downloading';
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });

    const photoIdx = { val: 1 };
    const videoIdx = { val: 1 };
    const gifIdx = { val: 1 };
    let skippedRepost = 0;

    function reportDownloadProgress() {
      downloadState.progress = Math.round((completed / total) * 100);
      downloadState.details = `Processed ${completed}/${total} · ${downloadedFiles.length} saved · ${failures.length} failed · ${skippedRepost} duplicates`;
      broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
    }

    async function downloadOne(item) {
      let failure;
      for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
        const pending = {
          requestId: crypto.randomUUID(),
          chunks: new Map(),
          resolve: null,
          reject: null,
          timer: 0
        };
        const result = new Promise((resolve, reject) => {
          pending.resolve = resolve;
          pending.reject = reject;
        });
        pending.timer = setTimeout(() => {
          if (pendingDownloads.get(item.id) === pending) {
            pendingDownloads.delete(item.id);
            pending.reject(new Error('Media transfer timed out'));
          }
        }, 180000);
        pendingDownloads.set(item.id, pending);

        try {
          const start = await chrome.tabs.sendMessage(tab.id, {
            type: 'FETCH_MEDIA_START',
            data: { url: item.url, itemId: item.id, mediaType: item.type, requestId: pending.requestId }
          });

          if (!start?.started) {
            throw new Error(start?.error || 'Could not start media fetch');
          }

          const resp = await result;

          let ext = item.ext || 'bin';
          const mimeMap = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
            'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm',
            'audio/ogg': 'ogg'
          };
          if (resp.mimeType && mimeMap[resp.mimeType]) {
            ext = mimeMap[resp.mimeType];
          } else if (resp.ext && resp.ext !== 'bin') {
            ext = resp.ext;
          }

          let folder = 'Other';
          let idx = 1;
          if (item.type === 'photo') { folder = 'Photos'; idx = photoIdx.val++; }
          else if (item.type === 'video') { folder = 'Videos'; idx = videoIdx.val++; }
          else if (item.type === 'gif' || item.type === 'animation') { folder = 'GIFs'; idx = gifIdx.val++; }

          const prefix = { photo: 'photo', video: 'video', gif: 'animation', animation: 'animation' };
          const filename = `${prefix[item.type] || 'media'}_${String(idx).padStart(3, '0')}.${ext}`;
          const path = `Telegram_Export/${folder}/${filename}`;

          // Stream bytes into the ZIP immediately — the service worker keeps
          // only metadata, the offscreen document holds the growing archive.
          const packed = await addZipFile(pending.requestId, { path, size: resp.size, mediaType: item.type }, resp.chunks);
          if (!packed.ok) throw new Error('ZIP writer did not confirm the media file');
          if (packed.duplicate) skippedRepost++;
          else downloadedFiles.push({ path, size: resp.size, item, recovery: resp.recovery });

          completed++;
          reportDownloadProgress();
          return;
        } catch (err) {
          failure = err;
          clearTimeout(pending.timer);
          if (pendingDownloads.get(item.id) === pending) {
            pendingDownloads.delete(item.id);
          }
          if (attempt < RETRY_COUNT - 1) {
            await wait(RETRY_DELAY * (attempt + 1));
            continue;
          }
          break;
        }
      }
      failures.push({
        messageId: item.messageId,
        type: item.type,
        error: safeExportError(failure?.message)
      });
      completed++;
      reportDownloadProgress();
    }

    const queue = [...items];
    const workers = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item) {
            await downloadOne(item);
          }
        }
      })());
    }
    await Promise.all(workers);

    if (!downloadedFiles.length) throw new Error(failures[0]?.error || 'No complete media to export');
    downloadState.failed = failures.length;
    downloadState.firstFailure = failures[0]?.error || '';
    downloadState.phase = 'zipping';
    downloadState.progress = 100;
    downloadState.details = skippedRepost > 0
      ? `Finalizing ZIP... (${skippedRepost} reposted media filtered)`
      : 'Finalizing ZIP file...';
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });

    const manifest = {
      exportDate: new Date().toISOString(),
      retry: retry || undefined,
      totalFiles: downloadedFiles.length,
      repostsFiltered: skippedRepost,
      errors: failures,
      categories: {
        photos: downloadedFiles.filter(f => f.item.type === 'photo').length,
        videos: downloadedFiles.filter(f => f.item.type === 'video').length,
        gifs: downloadedFiles.filter(f => f.item.type === 'gif' || f.item.type === 'animation').length
      },
      files: downloadedFiles.map(f => ({
        path: f.path,
        size: f.size,
        recovery: f.recovery || undefined,
        messageId: f.item.messageId,
        type: f.item.type
      }))
    };

    // Offscreen adds manifest.json, finalizes, and then reports
    // OFFSCREEN_ZIP_COMPLETE via the listener below.
    await sendOffscreenMessage('OFFSCREEN_FINISH_ZIP', { manifest });

  } catch (err) {
    downloadState = { active: false, phase: 'error', progress: 0, details: err.message };
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'MEDIA_DATA_CHUNK') {
    const d = msg.data || {};
    const pending = pendingDownloads.get(d.itemId);
    if (pending && pending.requestId === d.requestId) pending.chunks.set(d.seq, d.data);
  }
  if (msg.type === 'MEDIA_DATA_COMPLETE') {
    const d = msg.data || {};
    const pending = pendingDownloads.get(d.itemId);
    if (!pending || pending.requestId !== d.requestId) return;
    clearTimeout(pending.timer);
    pendingDownloads.delete(d.itemId);
    if (!d.success) {
      pending.reject(new Error(d.error || 'Media fetch failed'));
      return;
    }
    const seqs = Array.from(pending.chunks.keys()).sort((a, b) => a - b);
    const chunks = seqs.map((seq) => pending.chunks.get(seq));
    const size = chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
    if (!size || size !== d.size || seqs.length !== d.parts || seqs.some((seq, index) => seq !== index)) {
      pending.reject(new Error('Media transfer was incomplete'));
      return;
    }
    pending.resolve({
      chunks,
      size,
      mimeType: d.mimeType || '',
      recovery: d.recovery || '',
      ext: d.ext || ''
    });
  }
  if (msg.type === 'OFFSCREEN_ZIP_PROGRESS' && downloadState.phase === 'zipping') {
    downloadState.progress = msg.data.progress;
    downloadState.details = msg.data.details;
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
  }
  if (msg.type === 'OFFSCREEN_ZIP_READY') {
    startDownloadFromOffscreen(msg.data);
  }
  if (msg.type === 'OFFSCREEN_ZIP_ERROR') {
    downloadState = { active: false, phase: 'error', progress: 0, details: msg.data.error };
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
  }
});

async function startDownloadFromOffscreen(data) {
  try {
    if (!data?.blobUrl) throw new Error('No ZIP blob from offscreen');

    // Blob URL was created in the offscreen document (service workers cannot
    // call URL.createObjectURL). Only the string crosses the context boundary —
    // no multi-MB byte-array serialization anymore.
    const downloadId = await chrome.downloads.download({
      url: data.blobUrl,
      filename: data.filename,
      saveAs: true
    });

    const failureDetail = downloadState.failed
      ? ` · ${downloadState.failed} failed: ${downloadState.firstFailure}`
      : '';
    downloadState = {
      active: false,
      phase: 'complete',
      progress: 100,
      details: `ZIP created: ${data.filename}${failureDetail}`
    };
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
    broadcastToPopup('ZIP_READY', { filename: data.filename });

    // Release the blob once this download is done (offscreen revokes it)
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      const state = delta.state && delta.state.current;
      if (state === 'complete' || state === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        sendOffscreenMessage('OFFSCREEN_RELEASE_URL', { blobUrl: data.blobUrl })
          .catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  } catch (err) {
    const canceled = /USER_CANCELED/i.test(err?.message || '');
    downloadState = {
      active: false,
      phase: canceled ? 'complete' : 'error',
      progress: 0,
      details: canceled ? 'Download canceled' : err.message
    };
    broadcastToPopup('DOWNLOAD_PROGRESS', { ...downloadState });
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/zip.html',
      reasons: ['BLOBS'],
      justification: 'Create ZIP file from downloaded media'
    });
  }
}

function broadcastToPopup(type, data) {
  try {
    chrome.runtime.sendMessage({ type, data });
  } catch {}
}

async function addZipFile(requestId, file, chunks) {
  if (file.size <= 4 * 1024 * 1024) {
    return sendOffscreenMessage('OFFSCREEN_ADD_FILE', { ...file, data: chunks });
  }
  try {
    await sendOffscreenMessage('OFFSCREEN_FILE_START', { requestId, ...file });
    for (const chunk of chunks) {
      await sendOffscreenMessage('OFFSCREEN_FILE_CHUNK', { requestId, chunk });
    }
    return await sendOffscreenMessage('OFFSCREEN_FILE_END', { requestId });
  } catch (error) {
    await sendOffscreenMessage('OFFSCREEN_FILE_ABORT', { requestId }).catch(() => {});
    throw error;
  }
}

function sendOffscreenMessage(type, data) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type, data }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp && resp.error) {
          reject(new Error(resp.error));
          return;
        }
        resolve(resp || {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
