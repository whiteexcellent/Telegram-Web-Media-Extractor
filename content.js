/**
 * Content Script - Main entry point for Telegram Web pages (isolated world)
 * Coordinates media detection, chat scanning, and streams decrypted media
 * data from the page-world bridge (inject.js) to the background worker.
 */
(function () {
  'use strict';
  const TME = window.TelegramMediaExtractor;
  if (!TME) { console.error('[TME] Modules not loaded'); return; }

  const detector = new TME.MediaDetector();
  const scanner = new TME.ChatScanner(detector);

  /* ---------------- page bridge (postMessage to MAIN world) ---------------- */

  let gifScanTimer = null;
  const pendingPageFetches = new Map();
  let pageReqSeq = 0;
  let bridgeOk = null; // null = unknown, true/false = handshake result

  function postToPage(msg) {
    try {
      window.postMessage(msg, '*');
    } catch {}
  }

  function bridgePing(timeout = 1000) {
    if (bridgeOk === true) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = 'ping_' + (++pageReqSeq);
      const timer = setTimeout(() => {
        if (pendingPageFetches.delete(id)) resolve(false);
      }, timeout);
      pendingPageFetches.set(id, { pong: resolve, timer });
      postToPage({ __TME__: true, type: '__TME_PING__', id });
    });
  }

  function pageFetch(url, itemId, mediaType) {
    return new Promise((resolve, reject) => {
      const id = 'req_' + (++pageReqSeq);
      const rec = {
        chunks: [],
        parts: 0,
        mime: '',
        resolve,
        reject,
        id,
        timer: setTimeout(() => {
          pendingPageFetches.delete(id);
          reject(new Error('Page bridge timeout'));
        }, 180000)
      };
      pendingPageFetches.set(id, rec);
      postToPage({ __TME__: true, type: '__TME_FETCH__', req: { id, url, itemId, mediaType } });
    });
  }

  function onBridgeMessage(msg) {
    switch (msg.type) {
      case '__TME_BLOB_CREATED__': {
        detector.noteImageBlob(msg.data || {});
        if (msg.data?.mime === 'image/gif' && !gifScanTimer) {
          gifScanTimer = setTimeout(() => {
            gifScanTimer = null;
            dispatchDetected(detector.scanDocument());
          }, 60);
        }
        break;
      }
      case '__TME_URL_CAPTURED__': {
        const url = msg.data?.url;
        const mediaType = msg.data?.mediaType;
        if (url && (mediaType === 'stream' || /\/(?:web)?stream/i.test(url))) {
          registerStreamUrl(url);
        }
        break;
      }
      case '__TME_PONG__': {
        const rec = pendingPageFetches.get(msg.id);
        if (rec && rec.pong) {
          clearTimeout(rec.timer);
          pendingPageFetches.delete(msg.id);
          rec.pong(true);
        }
        break;
      }
      case '__TME_FETCH_RESULT__': {
        const keyRec = pendingPageKeys.get(msg.id);
        if (keyRec) {
          pendingPageKeys.delete(msg.id);
          if (msg.payload?.key || msg.payload?.visual) keyRec.resolve(msg.payload);
          else keyRec.reject(new Error(msg.payload?.error || 'Fingerprint failed'));
          break;
        }
        if (msg.payload && msg.payload.dataUrl) {
          const thumbRec = pendingPageThumbs.get(msg.id);
          if (thumbRec) {
            pendingPageThumbs.delete(msg.id);
            if (msg.payload.ok === false) thumbRec.reject(new Error(msg.payload.error || 'thumb failed'));
            else thumbRec.resolve({ dataUrl: msg.payload.dataUrl });
          }
          break;
        }
        const rec = pendingPageFetches.get(msg.id);
        if (!rec) break;
        const p = msg.payload || {};
        if (p.ok === false) {
          clearTimeout(rec.timer);
          pendingPageFetches.delete(msg.id);
          rec.reject(new Error(p.error || 'Page bridge fetch failed'));
          break;
        }
        rec.parts = p.parts || 0;
        rec.mime = p.mime || rec.mime;
        rec.chunks[p.seq] = p.bytes;
        const complete = rec.parts > 0 &&
          Array.from({ length: rec.parts }, (_, i) => rec.chunks[i]).every(Boolean);
        if (complete) {
          clearTimeout(rec.timer);
          pendingPageFetches.delete(msg.id);
          let total = 0;
          for (let i = 0; i < rec.parts; i++) total += rec.chunks[i].byteLength;
          if (!total || total !== p.total) {
            rec.reject(new Error('Page bridge sent an incomplete file'));
            break;
          }
          const bytes = new Uint8Array(total);
          let off = 0;
          for (let i = 0; i < rec.parts; i++) {
            bytes.set(rec.chunks[i], off);
            off += rec.chunks[i].byteLength;
          }
          rec.resolve({ bytes, mime: rec.mime, size: total, recovery: p.recovery });
        }
        break;
      }
    }
  }

  async function fetchViaPage(url, itemId, mediaType) {
    const available = await bridgePing();
    if (available) {
      bridgeOk = true;
      try {
        return await pageFetch(url, itemId, mediaType);
      } finally {
        // completed above or failed; keep Ok state either way
      }
    }
    bridgeOk = false;
    throw new Error('PAGE_BRIDGE_UNAVAILABLE');
  }

  async function fetchDirect(url) {
    if (!/^https?:/i.test(url)) throw new Error('PAGE_BRIDGE_UNAVAILABLE');
    const blob = await globalThis.TMEMediaResponse.fetchMediaBlob(url, {
      fetch: window.fetch.bind(window),
      signal: AbortSignal.timeout(150000)
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, mime: blob.type || '', size: bytes.byteLength };
  }

  function sniffMime(bytes) {
    if (!bytes || bytes.length < 12) return '';
    const b = bytes;
    const ascii = (offset, str) =>
      str.split('').every((ch, i) => b[offset + i] === ch.charCodeAt(0));
    if (ascii(4, 'ftyp')) return 'video/mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 'GIF8')) return 'image/gif';
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
    if (ascii(0, 'OggS')) return 'audio/ogg';
    if (ascii(0, 'ID3')) return 'audio/mpeg';
    return '';
  }

  function registerStreamUrl(absUrl) {
    try {
      const item = TME.MediaParser.parseStreamUrl(absUrl);
      // Image URLs need an attachment context to distinguish photos from covers.
      if (!item || item.type === 'photo') return false;
      const detected = detector.addExternalItem(item);
      if (detected) {
        dispatchDetected([detected]);
        return true;
      }
    } catch {}
    return false;
  }

  /* ---------------- continuous auto-scan engine ---------------- */

  // While the user is actively reading/scrolling, stay out of the way;
  // scan aggressively the rest of the time, for the whole session.
  const userActiveUntil = { ts: 0 };

  function setupUserActivityWatch() {
    const bump = () => { userActiveUntil.ts = Date.now() + 15000; };
    window.addEventListener('wheel', bump, { passive: true });
    window.addEventListener('touchstart', bump, { passive: true });
    window.addEventListener('keydown', bump);
  }

  async function autoDetectEnabled() {
    try {
      const { autoDetect = true } = await chrome.storage.local.get('autoDetect');
      return autoDetect !== false;
    } catch { return true; }
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function runScanPass() {
    return new Promise((resolve) => {
      if (scanner.isScanning) { resolve(); return; }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      scanner.onProgress = (p) => sendToBackground('SCAN_PROGRESS', p);
      scanner.onComplete = (p) => {
        sendToBackground('SCAN_COMPLETE', {
          ...p,
          totalFound: detector.getAll().length,
          stats: detector.getStats()
        });
        done();
      };
      scanner.scan('up').catch((err) => {
        sendToBackground('SCAN_COMPLETE', {
          status: 'error',
          error: err?.message || String(err),
          totalFound: detector.getAll().length,
          stats: detector.getStats()
        });
        done(); // never let a failed pass stall the loop for the stall-guard timeout
      });
      setTimeout(done, 150000); // stall guard: scan has its own retry caps
    });
  }

  async function continuousScanLoop() {
    if (continuousScanLoop.running) return;
    continuousScanLoop.running = true;
    let idleStreak = 0;
    while (true) {
      try {
        if (document.visibilityState !== 'visible') { await wait(5000); continue; }
        if (Date.now() < userActiveUntil.ts) { await wait(1500); continue; }
        if (scanner.isScanning) { await wait(2000); continue; }
        if (!(await autoDetectEnabled())) { await wait(5000); continue; }

        const before = detector.getAll().length;
        await runScanPass();
        const after = detector.getAll().length;
        idleStreak = after > before ? 0 : idleStreak + 1;
        // Yielding pass → continue immediately; idle pass → short back-off before retrying.
        await wait(after > before ? 1200 : (idleStreak > 2 ? 10000 : 4000));
      } catch {
        await wait(5000);
      }
    }
  }

  /* ---------------- init ---------------- */

  function init() {
    listenForBridge();
    postToPage({ __TME__: true, type: '__TME_STREAM_SNAPSHOT__' });
    detector.onMediaRemoved = (ids) => sendToBackground('MEDIA_REMOVED', { ids });
    detector.startObserving();
    document.addEventListener('load', (event) => {
      const image = event.target;
      if (image.tagName !== 'IMG') return;
      const item = detector.dupDetector.find({ url: image.currentSrc || image.src });
      if (item?.type === 'photo' && !item.visualFingerprint) {
        fingerprintQueue = fingerprintQueue.then(() => requestFingerprint(item.id, item.url, item.type));
      }
    }, true);
    detector.onMediaFound = (newItems) => {
      dispatchDetected(newItems);
    };
    const initialItems = detector.scanDocument();
    if (initialItems.length > 0) {
      dispatchDetected(initialItems);
    }
    setupMessageListener();
    startRescanLoop();
    setupChatSwitchReset();
    setupUserActivityWatch();
    continuousScanLoop();
  }

  // Web K lazily mounts/swaps media even without DOM "new" churn the
  // observer reliably sees — re-scan periodically for stragglers.
  function startRescanLoop() {
    setInterval(() => {
      try {
        if (scanner.isScanning) return;
        if (document.visibilityState !== 'visible') return;
        const items = detector.scanDocument();
        if (items.length > 0) {
          dispatchDetected(items);
        }
      } catch {}
    }, 3000);
  }

  // Per-chat isolation: Web K identifies chats in the hash (…/k/#-100123…).
  // On chat switch, reset the list so exports contain only this chat.
  function setupChatSwitchReset() {
    window.addEventListener('hashchange', () => {
      try {
        scanner.stop();
        detector.clear();
        userActiveUntil.ts = 0;   // allow an immediate first pass on the new chat
        sendToBackground('CLEAR_MEDIA');
      } catch {}
    });
  }

  function listenForBridge() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.__TME__ !== true) return;
      onBridgeMessage(d);
    });
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      switch (msg.type) {
        case 'SCAN_CHAT':
          handleScanChat(msg.data, sendResponse);
          return true;
        case 'STOP_SCANNING':
          scanner.stop();
          sendResponse({ success: true });
          return false;
        case 'GET_MEDIA':
          dispatchDetected(detector.scanDocument());
          sendResponse({ items: detector.getAll(), stats: detector.getStats() });
          return false;
        case 'GET_CHAT_INFO':
          sendResponse({
            chatName: TME.MediaParser.getChatName(),
            version: TME.MediaParser.detectVersion(),
            bridge: bridgeOk === true
          });
          return false;
        case 'FETCH_MEDIA_START':
          handleFetchMediaStart(msg.data, sendResponse);
          return true;
        case 'GET_ITEM_THUMB':
          handleGetItemThumb(msg.data, sendResponse);
          return true;
        case 'CLEAR_MEDIA':
          detector.clear();
          sendResponse({ success: true });
          return false;
        case 'PING':
          sendResponse({
            alive: true,
            version: TME.MediaParser.detectVersion(),
            bridge: bridgeOk === true
          });
          return false;
        default:
          return false;
      }
    });
  }

  async function handleScanChat(data, sendResponse) {
    scanner.onProgress = (progress) => {
      sendToBackground('SCAN_PROGRESS', progress);
    };
    scanner.onComplete = (progress) => {
      sendToBackground('SCAN_COMPLETE', {
        ...progress,
        totalFound: detector.getAll().length,
        stats: detector.getStats()
      });
    };
    sendResponse({ started: true });
    const direction = data?.direction || 'up';
    scanner.scan(direction);
  }

  /* ---------------- media transfer (streamed to background) ---------------- */

  const BG_CHUNK = 256 * 1024; // per-message chunk for the extension pipeline

  async function handleFetchMediaStart(data, sendResponse) {
    const url = data?.url || '';
    const itemId = data?.itemId || '';
    const requestId = data?.requestId;
    if (!url || url.startsWith('data:')) {
      sendResponse({ started: false, itemId, error: 'Unsupported media URL' });
      return;
    }

    // Confirm we can stream before background starts waiting for chunks
    sendResponse({ started: true, itemId });

    let bytes = null;
    let mime = '';
    let size = 0;
    let recovery;

    try {
      try {
        const bridged = await fetchViaPage(url, itemId, data.mediaType);
        bytes = bridged.bytes;
        mime = bridged.mime || '';
        size = bridged.size;
        recovery = bridged.recovery;
      } catch (bridgeErr) {
        // Fallback: direct fetch from content-script context (http(s) CDN thumbs etc.)
        if (!/^https?:/i.test(url) || TME.MediaParser.parseStreamUrl(url)) throw bridgeErr;
        const direct = await fetchDirect(url);
        bytes = direct.bytes;
        mime = direct.mime;
        size = direct.size;
      }

      if (!size) throw new Error('Empty media data');
      mime = sniffMime(bytes) || mime;

      const parts = Math.max(1, Math.ceil(size / BG_CHUNK));
      for (let i = 0; i < parts; i++) {
        const slice = bytes.subarray(i * BG_CHUNK, Math.min((i + 1) * BG_CHUNK, size));
        await chrome.runtime.sendMessage({
          type: 'MEDIA_DATA_CHUNK',
          data: { itemId, requestId, seq: i, data: Array.from(slice) }
        });
      }

      sendToBackground('MEDIA_DATA_COMPLETE', {
        itemId,
        requestId,
        success: true,
        parts,
        size,
        recovery,
        mimeType: mime,
        ext: mime ? TME.MediaParser.getExtensionFromMime(mime) : ''
      });
    } catch (err) {
      sendToBackground('MEDIA_DATA_COMPLETE', {
        itemId,
        requestId,
        success: false,
        error: err?.message || String(err)
      });
    }
  }

  function sendToBackground(type, data) {
    try {
      chrome.runtime.sendMessage({ type, data });
    } catch {}
  }

  /* ---------------- blob-capture items (photos never on <img src>) ---------------- */

  // Single dispatch point for detected/created items: push to the background
  // store and request a content fingerprint for every blob-sourced item.
  const stagedUrls = new Set();

  function dispatchDetected(items) {
    if (!items || !items.length) return;
    sendToBackground('MEDIA_DETECTED', { items, stats: detector.getStats() });
    for (const it of items) {
      if ((it.type === 'photo' || it.type === 'gif') && it.url?.startsWith('blob:') && !stagedUrls.has(it.url)) {
        stagedUrls.add(it.url);
        postToPage({ __TME__: true, type: '__TME_RETAIN__', req: { url: it.url, mediaType: it.type } });
      }
      if (it.url && (it.type === 'photo' ? !it.visualFingerprint : it.url.startsWith('blob:') && !it.contentKey)) {
        const { id, url, type } = it;
        fingerprintQueue = fingerprintQueue.then(() => requestFingerprint(id, url, type));
      }
    }
  }

  /* ---------------- content fingerprint (auto repost dedupe) ---------------- */

  const pendingPageKeys = new Map();
  let fingerprintQueue = Promise.resolve();

  async function requestFingerprint(itemId, url, mediaType) {
    try {
      const current = detector.mediaItems.get(itemId);
      if (current?.url !== url || current.type !== mediaType) return;
      const available = await bridgePing();
      if (!available) return;
      const reqId = `key_${(++pageReqSeq)}`;
      const done = new Promise((resolve, reject) => {
        pendingPageKeys.set(reqId, { resolve, reject });
        setTimeout(() => {
          if (pendingPageKeys.delete(reqId)) reject(new Error('Key timeout'));
        }, 15000);
      });
      postToPage({ __TME__: true, type: '__TME_CONTENT_KEY__', req: { id: reqId, url, itemId, mediaType } });
      const { key, visual } = await done;
      const item = detector.mediaItems.get(itemId);
      if (item?.url === url && item.type === mediaType) {
        if (key) item.contentKey = key;
        if (visual) item.visualFingerprint = visual;
        sendToBackground('MEDIA_FINGERPRINT', { id: itemId, url, key, visual });
      }
    } catch {}
  }

  /* ---------------- thumbnail via page bridge ---------------- */

  const pendingPageThumbs = new Map();

  async function handleGetItemThumb(data, respond) {
    const item = detector.getAll().find((i) => i.id === (data?.id || ''));
    if (!item) {
      respond({ ok: false, error: 'Item not found in this tab' });
      return;
    }
    try {
      const available = await bridgePing();
      if (!available) throw new Error('Page bridge unavailable');

      const reqId = `thumb_${(++pageReqSeq)}`;
      const done = new Promise((resolve, reject) => {
        pendingPageThumbs.set(reqId, { resolve, reject });
        setTimeout(() => {
          if (pendingPageThumbs.delete(reqId)) reject(new Error('Thumbnail timeout'));
        }, 20000);
      });

      postToPage({
        __TME__: true,
        type: '__TME_THUMB__',
        req: { id: reqId, url: item.url, width: 288, requestId: item.id }
      });

      const resp = await done;
      respond({ ok: true, dataUrl: resp.dataUrl });
    } catch (err) {
      respond({ ok: false, error: err?.message || String(err) });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
