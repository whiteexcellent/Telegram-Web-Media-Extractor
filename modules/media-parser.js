/**
 * Media Parser Module
 * Extracts metadata from DOM media elements for both Telegram Web K and A
 */
(function () {
  'use strict';
  const TME = window.TelegramMediaExtractor = window.TelegramMediaExtractor || {};

  const SUPPORTED_PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp'];
  const SUPPORTED_VIDEO_EXT = ['mp4', 'webm', 'mov'];
  const SUPPORTED_GIF_EXT = ['gif'];

  function detectVersion() {
    const url = window.location.href;
    if (url.includes('/k/')) return 'K';
    if (url.includes('/a/')) return 'A';
    return 'K';
  }

  function getMediaTypeFromMime(mime) {
    if (!mime) return 'unknown';
    if (mime.startsWith('image/gif')) return 'gif';
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    return 'unknown';
  }

  function getMediaTypeFromUrl(url) {
    if (!url) return 'unknown';
    const lower = url.toLowerCase();
    if (SUPPORTED_PHOTO_EXT.some(ext => lower.includes('.' + ext))) return 'photo';
    if (SUPPORTED_VIDEO_EXT.some(ext => lower.includes('.' + ext))) return 'video';
    if (SUPPORTED_GIF_EXT.some(ext => lower.includes('.' + ext))) return 'gif';
    return 'unknown';
  }

  function getExtensionFromMime(mime) {
    const map = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
      'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4',
      'video/webm': 'webm', 'video/quicktime': 'mov',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'
    };
    return map[mime] || 'bin';
  }

  function generateFilename(type, index, ext) {
    const prefix = { photo: 'photo', video: 'video', gif: 'animation', animation: 'animation' };
    return `${prefix[type] || 'media'}_${String(index).padStart(3, '0')}.${ext}`;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(1)} ${units[i]}`;
  }

  function extractMessageId(element) {
    let el = element;
    while (el && el !== document.body) {
      const mid = el.dataset?.mid || el.dataset?.messageId || el.getAttribute('data-mid') || el.getAttribute('data-message-id');
      if (mid) return mid;
      const idAttr = el.id;
      if (idAttr) {
        const match = idAttr.match(/message[-_]?(\d+)/i);
        if (match) return match[1];
      }
      el = el.parentElement;
    }
    return '';
  }

  // Telegram time nodes carry localized words (e.g. Turkish "5 Kas", "Bugün
  // 14:05") — new Date() becomes Invalid Date and .toISOString() would throw.
  // Never throw: return '' when unparseable.
  function safeIso(raw) {
    if (!raw) return '';
    const d = new Date(raw);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  function extractDate(element) {
    let el = element;
    while (el && el !== document.body) {
      const timeEl = el.querySelector('time, .time, .message-time, .time-inner, [data-timestamp]');
      if (timeEl) {
        const iso = safeIso(timeEl.getAttribute('datetime')) ||
                    safeIso(timeEl.dataset?.timestamp) ||
                    safeIso(timeEl.getAttribute('title')) ||
                    safeIso(timeEl.textContent ? timeEl.textContent.trim() : '');
        if (iso) return iso;
      }
      el = el.parentElement;
    }
    return new Date().toISOString();
  }

  const PROTECTED = '.is-protected, .no-forwards, .forward-restrict, [data-no-forwards="true"], [data-no-forwards="1"], [data-no-forwards=""]';

  function isProtectedContent(element) {
    if (element.closest(PROTECTED)) return true;
    const attachment = element.closest('.media-inner, .media-container, .attachment, .document');
    return Boolean(attachment?.querySelector(':scope > .protector'));
  }

  function getAttachmentKey(element, messageId, type) {
    if (!messageId) return '';
    const cell = element.closest('.album-item, .grouped-item');
    const slot = cell ? Array.prototype.indexOf.call(cell.parentElement?.children || [], cell) : '';
    return JSON.stringify([messageId, slot, type === 'gif' ? 'video' : type]);
  }

  function parseStreamUrl(rawUrl) {
    if (!rawUrl) return null;
    let parsed;
    try {
      parsed = new URL(rawUrl, window.location.href);
    } catch {
      return null;
    }
    // matches /stream/.. and Web K's /webstream/mtp/?... endpoints
    if (!/\/(?:web)?stream/i.test(parsed.pathname)) return null;

    const p = parsed.searchParams;

    // Some Web K variants pack the metadata inside a JSON parameter
    // (e.g. location=%7B%22id%22...%7D) — try to decode it.
    let json = null;
    for (const key of ['location', 'file', 'meta', 'metadata', 'script']) {
      const raw = p.get(key);
      if (!raw) continue;
      try {
        json = JSON.parse(raw);
      } catch {}
      if (json && typeof json === 'object') break;
      json = null;
    }

    // Web K main shape: JSON payload as the URL PATH after /stream/
    //   /k/stream/%7B%22dcId%22:4,...,"size":16943297,...%7D
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

    const mime = p.get('mime') || p.get('mimeType') || p.get('mime_type') ||
                 p.get('content_type') ||
                 (json && (json.mimeType || json.mime || json.content_type)) || '';
    const size = parseInt(p.get('size') || '', 10) ||
                 parseInt((json && json.size) || '', 10) || 0;
    const dcId = p.get('dcId') ||
                 (json && json.dcId != null ? String(json.dcId) : '');
    const locationId = p.get('location.id') ||
                 (json && json.location && json.location.id != null
                   ? String(json.location.id) : '') ||
                 (json && json.id != null ? String(json.id) : '') || '';

    let type = getMediaTypeFromMime(mime);
    if (type === 'unknown') type = getMediaTypeFromUrl(parsed.pathname);
    if (type === 'unknown') type = 'video';

    let ext = getExtensionFromMime(mime);
    if (ext === 'bin') {
      const m = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = m[1].toLowerCase();
    }

    const location = json?.location || json;
    const documentId = (!location?._ || location._ === 'inputDocumentFileLocation') &&
      (typeof location?.id !== 'number' || Number.isSafeInteger(location.id)) ? locationId : '';
    const streamKey = locationId ? `tme_stream_${dcId}_${locationId}` : '';
    return {
      streamKey,
      documentId,
      id: streamKey || `tme_stream_${crypto.randomUUID()}`,
      type,
      url: parsed.href,
      thumbnailUrl: '',
      filename: p.get('filename') ||
                (json && (json.fileName || json.filename)) || '',
      size,
      date: new Date().toISOString(),
      messageId: `stream_${locationId || Date.now().toString(36)}`,
      chatName: getChatName(),
      mimeType: mime,
      isProtected: false,
      width: 0,
      height: 0,
      duration: 0,
      ext,
      source: 'stream'
    };
  }

  function getChatName() {
    const version = detectVersion();
    const selectors = version === 'K'
      ? ['.chat-info .peer-title', '.top .peer-title', '.sidebar-header .peer-title']
      : ['.ChatInfo .title', '.MiddleHeader .title h3', '.chat-header .info-content h3'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return 'Telegram Chat';
  }

  function parseMediaElement(element, type, url) {
    try {
      const messageId = extractMessageId(element);
      const date = extractDate(element) || new Date().toISOString();
      const isProtected = isProtectedContent(element);
      const chatName = getChatName();

      let mime = '';
      let width = 0;
      let height = 0;
      let duration = 0;

      if (element.tagName === 'VIDEO') {
        mime = element.getAttribute('type') || 'video/mp4';
        width = element.videoWidth || element.width || 0;
        height = element.videoHeight || element.height || 0;
        duration = element.duration || 0;
      } else if (element.tagName === 'IMG') {
        mime = 'image/jpeg';
        width = element.naturalWidth || element.width || 0;
        height = element.naturalHeight || element.height || 0;
        const src = url || element.src;
        if (src) {
          if (src.includes('.png')) mime = 'image/png';
          else if (src.includes('.webp')) mime = 'image/webp';
          else if (/\.gif(?:[?#]|$)/i.test(src)) { mime = 'image/gif'; type = 'gif'; }
        }
      }

      const ext = getExtensionFromMime(mime);
      const id = `tme_${crypto.randomUUID()}`;

      return {
        id,
        type: type || 'photo',
        url: url || element.src || '',
        thumbnailUrl: element.src || '',
        filename: '',
        size: 0,
        date,
        messageId,
        attachmentKey: getAttachmentKey(element, messageId, type),
        chatName,
        mimeType: mime,
        isProtected,
        width,
        height,
        duration,
        ext
      };
    } catch {
      // A bad element must never break a scan/observer batch
      return null;
    }
  }

  TME.MediaParser = {
    detectVersion,
    getMediaTypeFromMime,
    getMediaTypeFromUrl,
    getExtensionFromMime,
    generateFilename,
    formatFileSize,
    extractMessageId,
    extractDate,
    isProtectedContent,
    getChatName,
    parseMediaElement,
    parseStreamUrl,
    SUPPORTED_PHOTO_EXT,
    SUPPORTED_VIDEO_EXT,
    SUPPORTED_GIF_EXT
  };
})();
