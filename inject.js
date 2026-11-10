/**
 * Inject Script - Page MAIN-world bridge
 * Runs at document_start (declared in manifest with world:"MAIN", so page CSP cannot block it).
 *
 * What it does:
 *  1. Hooks URL.createObjectURL so every blob/MediaSource object URL is linked to the
 *     underlying data BEFORE Telegram revokes it. For plain Blobs we keep a reference to
 *     the already-decrypted bytes (photos, GIFs, audio, thumbnails, MSE-less videos).
 *  2. Hooks MediaSource.addSourceBuffer / SourceBuffer.appendBuffer so every decrypted
 *     media segment fed into <video> players is captured for preview. Complete stream
 *     downloads use the original URL and validated byte ranges.
 *  3. Serves the captured (or freshly fetched, same-origin) bytes to the content script
 *     through a request/response postMessage protocol (__TME_PING__ / __TME_FETCH__).
 */
(function () {
  'use strict';
  if (window.__TME_BRIDGE__) return;
  window.__TME_BRIDGE__ = true;

  /* ---------------- capture registry ---------------- */

  const staging = new Map();
  const registry = new Map();        // objectURL -> entry
  const mseChunks = new WeakMap();   // MediaSource -> chunk list (array w/ .mime)
  let totalTrackedBytes = 0;

  const MAX_TOTAL_BYTES = 1.25 * 1024 * 1024 * 1024; // ~1.2 GB of retained media
  const MAX_ENTRIES = 1200;

  function toArrayBytes(data) {
    try {
      if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        );
      }
    } catch {}
    return new Uint8Array(0);
  }

  function mseList(ms) {
    let list = mseChunks.get(ms);
    if (!list) {
      list = [];
      mseChunks.set(ms, list);
    }
    return list;
  }

  function evict() {
    if (registry.size <= MAX_ENTRIES && totalTrackedBytes <= MAX_TOTAL_BYTES) return;
    for (const key of registry.keys()) {
      if (registry.size <= MAX_ENTRIES && totalTrackedBytes <= MAX_TOTAL_BYTES) break;
      const entry = registry.get(key);
      if (entry && entry.kind === 'blob') totalTrackedBytes -= entry.bytes || 0;
      registry.delete(key);
    }
  }

  /* ---------------- hook URL.createObjectURL ---------------- */

  const U = window.URL || window.webkitURL;
  if (!U) return;

  const origCreateObjectURL = U.createObjectURL.bind(U);
  // revoke is intentionally NOT forwarded through a wrapper that deletes the entry:
  // Telegram revokes URLs right after attaching media, but we still need the data later.
  const origRevokeObjectURL = U.revokeObjectURL.bind(U);

  U.createObjectURL = function (obj) {
    const url = origCreateObjectURL(obj);
    try {
      if (obj instanceof Blob) {
        registry.set(url, { kind: 'blob', blob: obj, bytes: obj.size, ts: Date.now() });
        totalTrackedBytes += obj.size;
      } else if (window.MediaSource && obj instanceof MediaSource) {
        const list = mseList(obj);
        registry.set(url, { kind: 'mse', chunks: list, mime: list.mime || '', ts: Date.now() });
      } else {
        registry.set(url, { kind: 'other', ts: Date.now() });
      }
      evict();
      notifyCaptured(url);
    } catch {}
    return url;
  };

  U.revokeObjectURL = function (url) {
    // Entry stays in the registry until memory policy evicts it.
    return origRevokeObjectURL(url);
  };

  /* ---------------- hook MediaSource segment appends ---------------- */

  if (window.MediaSource && MediaSource.prototype && MediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = origAddSourceBuffer.call(this, String(mime || ''));
      try {
        const list = mseList(this);
        if (!list.mime) list.mime = String(mime || '');
        const origAppend = sb.appendBuffer.bind(sb);
        sb.appendBuffer = function (data) {
          try {
            list.push(toArrayBytes(data));
          } catch {}
          return origAppend(data);
        };
      } catch {}
      return sb;
    };
  }

  /* ---------------- network hooks (/stream/ URLs) ---------------- */

  const STREAM_RE = /\/(?:web)?stream(?:\/|$)/i;

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (typeof u === 'string' && STREAM_RE.test(u)) notifyStreamLink(u);
    } catch {}
    return origFetch.apply(this, args);
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && STREAM_RE.test(url)) notifyStreamLink(url);
    } catch {}
    return origXhrOpen.call(this, method, url, ...rest);
  };

  // The isolated content script starts later than this hook.
  const streamLinks = new Set();
  const STREAM_LOG_MAX = 64;

  function notifyStreamLink(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin || !STREAM_RE.test(parsed.pathname)) return;
      const abs = parsed.href;
      if (streamLinks.has(abs)) return;
      streamLinks.add(abs);
      if (streamLinks.size > STREAM_LOG_MAX) streamLinks.delete(streamLinks.values().next().value);
      post({ type: '__TME_URL_CAPTURED__', data: { url: abs, mediaType: 'stream' } });
    } catch {}
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) notifyStreamLink(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {}

  function parseStreamMetaLite(urlStr) {
    let u;
    try { u = new URL(urlStr, location.href); } catch { return null; }
    if (u.origin !== location.origin || !STREAM_RE.test(u.pathname)) return null;
    let json = null;
    const m = u.pathname.match(/\/(?:web)?stream\/(.+)$/i);
    if (m && m[1]) {
      try {
        let dec = decodeURIComponent(m[1]);
        if (/%7[Bb]/.test(dec.slice(0, 3))) {
          try { dec = decodeURIComponent(dec); } catch {}
        }
        json = JSON.parse(dec);
      } catch { json = null; }
    }
    if (!json) {
      const raw = u.searchParams.get('location') || u.searchParams.get('script') || '';
      if (raw) {
        try { json = JSON.parse(raw); } catch {}
      }
    }
    const mime = u.searchParams.get('mime') || u.searchParams.get('mimeType') ||
                 (json && json.mimeType) || '';
    const size = parseInt(u.searchParams.get('size') || '', 10) ||
                 (json && json.size) || 0;
    return { mime: String(mime || ''), size: Number(size) || 0, ts: Date.now() };
  }

  /* ---------------- page <-> content messaging ---------------- */

  const REQUEST_TIMEOUT_MS = 150000;
  const SLICE = 4 * 1024 * 1024; // 4 MB per postMessage transfer

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__TME__ !== true) return;

    if (d.type === '__TME_STREAM_SNAPSHOT__') {
      for (const [url, entry] of registry) {
        if (entry.kind === 'blob' && entry.blob.type === 'image/gif') notifyCaptured(url);
      }
      for (const url of streamLinks) {
        post({ type: '__TME_URL_CAPTURED__', data: { url, mediaType: 'stream' } });
      }
      return;
    }

    if (d.type === '__TME_PING__') {
      post({ type: '__TME_PONG__', id: d.id });
      return;
    }

    if (d.type === '__TME_THUMB__') {
      const req = d.req || {};
      genThumb(req).catch((err) => {
        reply(req.id, { ok: false, error: (err && err.message) || String(err), requestId: req.requestId }, []);
      });
      return;
    }

    if (d.type === '__TME_CONTENT_KEY__') {
      const req = d.req || {};
      computeContentKeyFor(req).catch((err) => {
        reply(req.id, { ok: false, error: (err && err.message) || String(err) }, []);
      });
      return;
    }

    if (d.type === '__TME_RETAIN__') {
      const { url, mediaType } = d.req || {};
      if (typeof url === 'string' && url.startsWith('blob:') && ['photo', 'gif'].includes(mediaType) && !staging.has(url)) {
        const pending = retainMedia(url, mediaType).catch(() => {}).finally(() => staging.delete(url));
        staging.set(url, pending);
      }
      return;
    }

    if (d.type === '__TME_FETCH__') {
      const req = d.req || {};
      serve(req).catch((err) => {
        reply(req.id, { ok: false, error: (err && err.message) || String(err), itemId: req.itemId }, []);
      });
    }
  });

  async function serve(req) {
    const url = req.url || '';
    const itemId = req.itemId || '';
    const got = await getBlobForAsync(url, { mediaType: req.mediaType });
    if (!got.blob.size) throw new Error('Empty media buffer');

    const buf = await got.blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const total = bytes.byteLength;
    const parts = Math.max(1, Math.ceil(total / SLICE));
    for (let i = 0; i < parts; i++) {
      const portion = bytes.subarray(i * SLICE, Math.min((i + 1) * SLICE, total));
      const copy = portion.slice(); // standalone buffer for transfer
      reply(req.id, {
        ok: true,
        seq: i,
        parts,
        total,
        itemId,
        bytes: copy,
        mime: got.mime,
        recovery: got.recovery
      }, [copy.buffer]);
    }
  }

  /* ---------------- thumbnail generation (small JPEG previews) ---------------- */

  async function recoverDisplayedPhoto(url) {
    const image = findMatchingMediaEl(url);
    if (image?.tagName !== 'IMG' || !image.complete || !image.naturalWidth ||
        image.naturalWidth * image.naturalHeight > 16_000_000) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  async function retainMedia(url, mediaType) {
    const entry = registry.get(url);
    if (entry?.kind === 'mse') return;
    const { blob, recovery } = await getBlobForAsync(url, { mediaType, readStaging: false });
    if (blob.size <= 32 * 1024 * 1024) await globalThis.TMEMediaCache.put(url, { blob, recovery });
  }

  async function getBlobForAsync(url, { preview = false, mediaType, readStaging = true } = {}) {
    let blob = null;
    let mime = '';
    let recovery = '';

    const entry = registry.get(url);
    if (entry) {
      if (entry.kind === 'blob') {
        blob = entry.blob;
        mime = entry.blob.type || mime;
      } else if (entry.kind === 'mse') {
        if (!preview) {
          throw new Error('Only a playback buffer is available. Open the video in Telegram, then select its stream entry.');
        }
        const chunks = entry.chunks || [];
        // addSourceBuffer may run AFTER createObjectURL (typical Web K order),
        // so prefer the live mime recorded on the chunk list.
        const type = chunks.mime || entry.mime || '';
        blob = new Blob(chunks, { type });
        mime = type;
      }
    }

    if (!blob && readStaging && url.startsWith('blob:')) {
      try {
        await staging.get(url);
        const stored = await globalThis.TMEMediaCache.get(url);
        if (stored && !(mediaType === 'gif' && stored.recovery)) {
          return { blob: stored.blob, mime: stored.blob.type, recovery: stored.recovery };
        }
      } catch {}
    }

    // Blob URL that predates the hook (shouldn't happen with document_start, but be safe)
    if (!blob && url.startsWith('blob:')) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (resp.ok) {
          blob = await resp.blob();
          mime = blob.type || mime;
        }
      } catch {}
    }

    // Non-blob URL: fetch same-origin with credentials (stream endpoint, CDN thumbs)
    if (!blob && /^https?:/i.test(url)) {
      const stream = parseStreamMetaLite(url);
      if (preview && stream) {
        const response = await origFetch(url, {
          credentials: 'include',
          headers: { Range: 'bytes=0-' },
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error('Preview HTTP ' + response.status);
        blob = await response.blob();
      } else {
        blob = await globalThis.TMEMediaResponse.fetchMediaBlob(url, {
          fetch: origFetch.bind(window),
          stream: Boolean(stream),
          size: stream?.size,
          mime: stream?.mime,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      }
      mime = blob.type || mime;
    }

    if (!blob && mediaType === 'photo' && url.startsWith('blob:')) {
      try {
        blob = await recoverDisplayedPhoto(url);
        if (blob) {
          mime = blob.type;
          recovery = 'decoded-image-png';
        }
      } catch {}
    }

    if (!blob) throw new Error('Media source unavailable in page context');
    return { blob, mime, recovery };
  }

  function imgLoad(img, url) {
    return new Promise((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('img decode failed'));
      img.src = url;
    });
  }

  function canvasFromSource(srcEl, w, h, want) {
    const scale = Math.min(1, want / (w || want));
    const cw = Math.max(16, Math.round((w || want) * scale));
    const ch = Math.max(16, Math.round((h || want) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(srcEl, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.55);
  }

  function drawElementThumb(el, want) {
    try {
      if (!el) return null;
      if (el.tagName === 'VIDEO') {
        if (!(el.videoWidth > 16)) return null;
        return canvasFromSource(el, el.videoWidth, el.videoHeight, want);
      }
      if (el.tagName === 'IMG') {
        if (!el.complete || !(el.naturalWidth > 16)) return null;
        return canvasFromSource(el, el.naturalWidth, el.naturalHeight, want);
      }
    } catch {
      return null;
    }
    return null;
  }

  function findMatchingMediaEl(url) {
    if (!url) return null;
    const els = document.querySelectorAll('video, img');
    for (const el of els) {
      const s = el.currentSrc || el.src || '';
      if (s === url) return el;
    }
    return null;
  }

  async function drawBlobThumb(blob, want) {
    // use the ORIGINAL createObjectURL so preview buffers don't pile up in the registry
    const objUrl = origCreateObjectURL(blob);
    try {
      const img = new Image();
      await imgLoad(img, objUrl);
      return canvasFromSource(img, img.naturalWidth, img.naturalHeight, want);
    } finally {
      try { origRevokeObjectURL(objUrl); } catch {}
    }
  }

  async function drawVideoBlobThumb(blob, want) {
    const objUrl = origCreateObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    try {
      await new Promise((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error('video decode failed'));
        video.src = objUrl;
      });
      try {
        video.currentTime = Math.min(1, (video.duration || 1) * 0.25 || 0);
        await new Promise((res) => {
          const t = setTimeout(res, 1200);
          video.onseeked = () => { clearTimeout(t); res(); };
        });
      } catch {}
      if (!(video.videoWidth > 16)) throw new Error('no frame');
      return canvasFromSource(video, video.videoWidth, video.videoHeight, want);
    } finally {
      try { origRevokeObjectURL(objUrl); } catch {}
    }
  }

  async function genThumb(req) {
    const want = Math.min(512, Math.max(64, ((req.width | 0) || 240)));
    // 1) reuse a live page element (video frame / img) — cheapest path
    let dataUrl = drawElementThumb(findMatchingMediaEl(req.url), want);
    // 2) else decode the captured / fetched bytes ourselves
    if (!dataUrl) {
      const got = await getBlobForAsync(req.url, { preview: true });
      const type = ((got.blob.type || got.mime || '') + '').toLowerCase();
      if (type.startsWith('image/')) {
        dataUrl = await drawBlobThumb(got.blob, want);
      } else if (type.startsWith('video/') || type === 'application/octet-stream') {
        dataUrl = await drawVideoBlobThumb(got.blob, want);
      }
    }
    if (!dataUrl) throw new Error('Preview not available');
    reply(req.id, { ok: true, dataUrl, requestId: req.requestId }, []);
  }

  /* ---------------- content hash (repost/auto-dedupe) ---------------- */

  async function computeContentKeyFor(req) {
    const entry = registry.get(req.url);
    let blob = entry && entry.kind === 'blob' ? entry.blob : null;
    if (!blob && req.url && req.url.startsWith('blob:')) {
      try {
        const resp = await fetch(req.url, { credentials: 'include' });
        if (resp.ok) blob = await resp.blob();
      } catch {}
    }
    let key = '';
    if (blob?.size && blob.size <= 16 * 1024 * 1024) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      key = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    let visual = null;
    if (req.mediaType === 'photo') {
      let bitmap;
      try {
        const element = findMatchingMediaEl(req.url);
        if (element?.tagName === 'IMG' && element.complete && element.naturalWidth) {
          visual = globalThis.TMEPhotoFingerprint.describe(element);
        } else if (blob?.size && blob.size <= 16 * 1024 * 1024) {
          bitmap = await createImageBitmap(blob);
          visual = globalThis.TMEPhotoFingerprint.describe(bitmap);
        }
      } catch {
        // An unreadable or cross-origin canvas can still use a byte hash.
      } finally {
        bitmap?.close();
      }
    }
    if (!key && !visual) throw new Error('Fingerprint source unavailable');
    reply(req.id, { ok: true, key, visual }, []);
  }

  function notifyCaptured(url) {
    const entry = registry.get(url);
    // Videos: covered by DOM observer + /stream registration — creating items
    // from video blobs directly would double-count the same file.
    if (!entry || entry.kind !== 'blob') return;
    const mime = (entry.blob && entry.blob.type) || '';
    const bytes = entry.bytes || 0;
    // This is metadata only. The isolated script requires a photo attachment
    // before treating an image URL as exportable media.
    if (!/^image\/(jpeg|png|gif)$/i.test(mime)) return;
    if (mime !== 'image/gif' && bytes < 20480) return;
    post({
      type: '__TME_BLOB_CREATED__',
      data: { url, bytes, mime }
    });
  }

  function reply(id, payload, transfer) {
    try {
      window.postMessage(
        { __TME__: true, type: '__TME_FETCH_RESULT__', id, payload },
        '*',
        transfer || []
      );
    } catch {}
  }

  function post(msg) {
    try {
      window.postMessage({ __TME__: true, ...msg }, '*');
    } catch {}
  }
})();
