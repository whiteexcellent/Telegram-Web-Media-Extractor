/**
 * Media Detector Module
 * Core detection engine for finding media elements in Telegram Web DOM
 * Supports both Telegram Web K and Telegram Web A
 */
(function () {
  'use strict';
  const TME = window.TelegramMediaExtractor = window.TelegramMediaExtractor || {};

  const SELECTORS = {
    K: {
      messageContainer: '.bubbles-inner',
      message: '.bubble:not(.is-date)',
      photo: '.media-photo, .media-container img, .attachment img, .media-viewer-aspecter img',
      video: 'video, .media-video',
      gif: '.media-gif-wrapper, .gif-wrapper, .document.ext-gif, [data-is-gif]:not([data-is-gif="false"])',
      mediaWrapper: '.media-container, .media-photo-container, .attachment',
      protectedOverlay: '.forward-restrict, .no-forwards',
      chatContainer: '.chat, .bubbles',
      avatar: '.avatar-photo, .peer-photo-initials',
      sticker: '.media-sticker, .sticker-container'
    },
    A: {
      messageContainer: '#MiddleColumn .messages-container, .MessageList',
      message: '.Message, .message',
      photo: '.media-inner img, .full-media img, .thumbnail img, .photo-content img',
      video: 'video, .media-inner video, .full-media video',
      gif: '.gif-wrapper, [data-is-gif]:not([data-is-gif="false"])',
      mediaWrapper: '.media-inner, .full-media, .message-content-wrapper',
      protectedOverlay: '.no-forwards, [data-no-forwards]',
      chatContainer: '.messages-container, .MessageList',
      avatar: '.Avatar img, .avatar-photo',
      sticker: '.Sticker, .media-sticker'
    }
  };

  const VIDEO_HOST = [
    'video', '.media-video', '.media-video-container', '.media-poster', '.media-round',
    '.media-gif-wrapper', '.document-video', '.video-attachment', '.video-message',
    '.media-inner.dark', '[data-media-type="video"]',
    ...['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', 'wmv', 'flv']
      .map(ext => `.document.ext-${ext}`)
  ].join(', ');
  const VIDEO_MARKER = 'video, .video-time, .video-play, .message-media-duration, .message-media-last-progress';
  const MEDIA_CELL = [
    '.media-container', '.media-photo-container', '.attachment', '.album-item', '.grouped-item',
    '.media-inner', '.full-media:not(img)', '.media-viewer-aspecter', '.document'
  ].join(', ');
  const ALBUM_CELL = '.album-item, .grouped-item';
  const MESSAGE = '.bubble, .Message, .message';

  class MediaDetector {
    constructor() {
      this.version = TME.MediaParser.detectVersion();
      this.sel = SELECTORS[this.version];
      this.dupDetector = new TME.DuplicateDetector();
      this.mediaItems = new Map();
      this.observer = null;
      this.interceptedUrls = new Map();
      this.onMediaFound = null;
      this.onMediaRemoved = null;
      this.mediaElements = new Map();
      this.imageBlobs = new Map();
    }

    getSelectors() {
      return this.sel;
    }

    scanDocument() {
      this.pruneVideoPosters();
      const items = [];
      try { this._scanPhotos(items); } catch {}
      try { this._scanVideos(items); } catch {}
      try { this._scanGifs(items); } catch {}
      try { this._scanStreams(items); } catch {}
      return items;
    }

    _isAvatar(el) {
      const avSels = [this.sel.avatar, '.avatar', '.user-avatar', '.peer-photo'].join(',');
      return !!el.closest(avSels);
    }

    _isSticker(el) {
      const stSels = [this.sel.sticker, '.sticker', '.emoji', '.AnimatedSticker'].join(',');
      return !!el.closest(stSels);
    }

    _isThumbnail(el) {
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      if (w > 0 && w < 40 && h > 0 && h < 40 && !this._isGifImage(this._sourceOf(el))) return true;
      return el.classList?.contains('thumbnail-image') || el.classList?.contains('avatar-mini');
    }

    _gifHost(el) {
      const explicit = el.closest(this.sel.gif);
      if (explicit) return explicit;
      const cell = el.closest('.media-inner, .media-container');
      const badge = cell?.querySelector(':scope > .message-media-duration, :scope > .video-time');
      return badge?.textContent.trim().toUpperCase() === 'GIF' ? cell : null;
    }

    _sourceOf(el) {
      return el.currentSrc || el.src || el.querySelector('source[src]')?.src ||
        el.getAttribute('href') || el.getAttribute('xlink:href') || el.dataset?.src || '';
    }

    _isGifImage(src) {
      return this.imageBlobs.get(src)?.mime === 'image/gif' || /\.gif(?:[?#]|$)/i.test(src);
    }

    _isVideoPoster(el) {
      if (el.closest(VIDEO_HOST)) return true;

      const message = el.closest(MESSAGE);
      const albumCell = el.closest(ALBUM_CELL);
      for (let cell = el.closest(MEDIA_CELL); cell; cell = cell.parentElement?.closest(MEDIA_CELL)) {
        if ((message && !message.contains(cell)) || (albumCell && !albumCell.contains(cell))) break;
        for (const marker of cell.querySelectorAll(VIDEO_MARKER)) {
          if (marker.closest(MEDIA_CELL) === cell) return true;
        }
      }
      return false;
    }

    noteImageBlob({ url, mime, bytes }) {
      if (!url || !bytes) return;
      this.imageBlobs.set(url, { mime, bytes });
      if (this.imageBlobs.size > 1200) this.imageBlobs.delete(this.imageBlobs.keys().next().value);
    }

    pruneVideoPosters() {
      const removed = [];
      for (const [id, ref] of this.mediaElements) {
        const item = this.mediaItems.get(id);
        if (item?.type !== 'photo') continue;
        const el = ref.deref();
        if (!el) {
          this.mediaElements.delete(id);
          continue;
        }
        if (!el.isConnected || !this._isVideoPoster(el)) continue;
        this.mediaElements.delete(id);
        this.mediaItems.delete(id);
        this.dupDetector.remove(item);
        removed.push(id);
      }
      if (removed.length) this.onMediaRemoved?.(removed);
    }

    // Single choke point: parse must NEVER throw into a scan/observer batch.
    // Returns true when a new item was added to `bucket`.
    _safeParse(el, type, src, bucket) {
      try {
        if (!src || src.startsWith('data:')) return false;
        const gifHost = this._gifHost(el);
        const image = type === 'photo' ? this.imageBlobs.get(src) : null;
        const stream = TME.MediaParser.parseStreamUrl(src);
        const gifImage = type === 'photo' && (this._isGifImage(src) || stream?.type === 'gif');
        if (type === 'photo' && this._isVideoPoster(el) && !(gifImage && gifHost)) return false;

        const mediaType = gifImage || (type === 'video' && gifHost) || stream?.type === 'gif' ? 'gif' : type;
        const domItem = TME.MediaParser.parseMediaElement(el, mediaType, src);
        if (!domItem?.url) return false;
        const item = stream
          ? { ...domItem, ...stream, type: mediaType, attachmentKey: domItem.attachmentKey,
              messageId: domItem.messageId, isProtected: domItem.isProtected }
          : domItem;
        if (gifHost?.dataset.docId && mediaType === 'gif') item.documentId = gifHost.dataset.docId;
        if (image || gifImage) {
          item.size = image?.bytes || item.size;
          item.mimeType = gifImage ? 'image/gif' : image.mime;
          item.ext = TME.MediaParser.getExtensionFromMime(item.mimeType);
        }
        const detected = this.addExternalItem(item, el);
        if (detected) {
          bucket?.push(detected);
          return true;
        }
      } catch {}
      return false;
    }
    _scanPhotos(items) {
      const photos = document.querySelectorAll(`${this.sel.photo}, .bubbles img`);
      photos.forEach(img => {
        if (this._isAvatar(img) || this._isSticker(img) || this._isThumbnail(img)) return;
        const src = this._sourceOf(img);
        if (src && !src.startsWith('data:') && !src.includes('emoji') && !src.includes('sticker')) {
          this._safeParse(img, 'photo', src, items);
        }
      });
      this._scanBackgroundImages(items);
    }

    _scanBackgroundImages(items) {
      // Wrapper selectors + any leftover inline background-image containers
      // (Web K sometimes paints grid/album cells without an <img> on top).
      const containers = document.querySelectorAll(
        `${this.sel.mediaWrapper}, [style*="background-image"]`
      );
      containers.forEach(container => {
        if (!this._isAvatar(container) && !this._isSticker(container)) {
          const bg = getComputedStyle(container).backgroundImage;
          if (bg && bg !== 'none' && bg.startsWith('url(')) {
            const match = bg.match(/url\(["']?(.*?)["']?\)/);
            if (match?.[1] && !match[1].includes('emoji') && !match[1].startsWith('data:')) {
              this._safeParse(container, 'photo', match[1], items);
            }
          }
        }
      });
    }

    _scanVideos(items) {
      const videos = document.querySelectorAll(this.sel.video);
      videos.forEach(video => {
        if (this._isSticker(video)) return;
        const src = this._sourceOf(video);
        if (!src) return;
        this._safeParse(video, 'video', src, items);
      });
    }

    _scanGifs(items) {
      const hosts = new Set(document.querySelectorAll(this.sel.gif));
      for (const badge of document.querySelectorAll('.message-media-duration, .video-time')) {
        const host = this._gifHost(badge);
        if (host) hosts.add(host);
      }
      for (const host of hosts) {
        if (this._isSticker(host) || this._isAvatar(host)) continue;
        const images = host.matches('img, image') ? [host] : host.querySelectorAll('img, image');
        for (const image of images) {
          const src = this._sourceOf(image);
          if (this._isGifImage(src)) this._safeParse(image, 'photo', src, items);
        }
        const item = TME.MediaParser.parseMediaElement(host, 'gif', '');
        if (!item) continue;
        item.url = '';
        item.documentId = host.dataset.docId || '';
        if (!item.attachmentKey && !item.documentId) continue;
        const detected = this.addExternalItem(item, host);
        if (detected) items.push(detected);
      }
    }

    _scanStreams(items) {
      const els = document.querySelectorAll('video, video source, source, img, a[href]');
      els.forEach(el => {
        if (this._isSticker(el)) return;
        const u = el.currentSrc || el.src || el.getAttribute('href') || '';
        if (!u || !/\/(?:web)?stream/i.test(u)) return;
        let abs;
        try {
          abs = new URL(u, window.location.href).href;
        } catch {
          return;
        }
        try {
          const item = TME.MediaParser.parseStreamUrl(abs);
          if (!item || (item.type === 'photo' && this._isVideoPoster(el))) return;
          if (item.type === 'video' && this._gifHost(el)) item.type = 'gif';
          item.isProtected = TME.MediaParser.isProtectedContent(el);
          const detected = this.addExternalItem(item, el);
          if (detected) items.push(detected);
        } catch {}
      });
    }

    addExternalItem(item, element) {
      if (!item) return null;
      const existing = this.dupDetector.find(item);
      if (existing) {
        const attachment = this.dupDetector.byAttachment.get(item.attachmentKey);
        if (attachment && attachment !== existing && item.source === 'stream' && attachment.source !== 'stream') {
          item.isProtected ||= attachment.isProtected;
          this.dupDetector.remove(attachment);
          this.mediaItems.delete(attachment.id);
          this.mediaElements.delete(attachment.id);
          this.onMediaRemoved?.([attachment.id]);
        }
        const previousElement = this.mediaElements.get(existing.id)?.deref();
        if (element && (item.isProtected || !previousElement?.isConnected)) {
          this.mediaElements.set(existing.id, new WeakRef(element));
        }
        const sameAttachment = item.attachmentKey && item.attachmentKey === existing.attachmentKey;
        const sameStream = item.streamKey && item.streamKey === existing.streamKey;
        const refreshAttachment = sameAttachment && (element === previousElement || !previousElement?.isConnected ||
          (item.source === 'stream' && existing.source !== 'stream'));
        const refreshStream = sameStream && (!previousElement?.isConnected || element === previousElement);
        const refresh = item.url && (!existing.url || ((refreshAttachment || refreshStream) &&
          existing.url !== item.url && (existing.source !== 'stream' || item.source === 'stream')));
        const gif = item.type === 'gif' && existing.type !== 'gif';
        const bindDocument = item.documentId && !existing.documentId;
        const protectedNow = item.isProtected && !existing.isProtected;
        const bindAttachment = item.attachmentKey && !existing.attachmentKey;
        if (!refresh && !protectedNow && !bindAttachment && !gif && !bindDocument) return null;
        this.dupDetector.remove(existing);
        if (refresh) {
          existing.url = item.url;
          existing.contentKey = '';
          existing.visualFingerprint = null;
          existing.source = item.source;
          existing.streamKey = item.streamKey;
          existing.mimeType = item.mimeType;
          existing.ext = item.ext;
          existing.size = item.size;
        }
        if (gif) {
          existing.type = 'gif';
          if (item.mimeType === 'image/gif') {
            existing.mimeType = item.mimeType;
            existing.ext = item.ext;
          }
        }
        if (bindDocument) existing.documentId = item.documentId;
        if (protectedNow) existing.isProtected = true;
        if (bindAttachment) existing.attachmentKey = item.attachmentKey;
        this.dupDetector.add(existing);
        return existing;
      }
      this.dupDetector.add(item);
      this.mediaItems.set(item.id, item);
      if (element) this.mediaElements.set(item.id, new WeakRef(element));
      return item;
    }

    startObserving() {
      if (this.observer) this.stopObserving();
      const observer = new MutationObserver(mutations => {
        let hasNewMedia = false;
        let videoMarkupChanged = false;
        const newItems = [];
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (node.matches(VIDEO_HOST) || node.matches(VIDEO_MARKER) ||
                  node.querySelector(VIDEO_MARKER) || node.querySelector(VIDEO_HOST)) {
                videoMarkupChanged = true;
              }
              const mediaEls = [
                ...node.querySelectorAll?.('img, video') || [],
                ...(node.tagName === 'IMG' || node.tagName === 'VIDEO' ? [node] : [])
              ];
              for (const el of mediaEls) {
                if (this._isAvatar(el) || this._isSticker(el) || this._isThumbnail(el)) continue;
                const src = this._sourceOf(el);
                if (!src || src.startsWith('data:') || src.includes('emoji')) continue;
                let type = 'photo';
                if (el.tagName === 'VIDEO') {
                  type = 'video';
                }
                if (this._safeParse(el, type, src, newItems)) hasNewMedia = true;
              }
            }
          } else if (mutation.type === 'attributes') {
            const target = mutation.target;
            if (target.matches(VIDEO_HOST) || target.matches(VIDEO_MARKER) || target.matches(MEDIA_CELL)) {
              videoMarkupChanged = true;
            }
            if ((target.tagName === 'IMG' || target.tagName === 'VIDEO') && mutation.attributeName === 'src') {
              const src = target.src;
              if (src && !src.startsWith('data:')) {
                const type = target.tagName === 'VIDEO'
                  ? 'video'
                  : 'photo';
                if (this._safeParse(target, type, src, newItems)) hasNewMedia = true;
              }
            }
          }
        }
        if (videoMarkupChanged) this.pruneVideoPosters();
        if (hasNewMedia && this.onMediaFound) {
          this.onMediaFound(newItems.filter(item => this.mediaItems.has(item.id)));
        }
      });

      // Always observe document.body: Telegram Web K rebuilds .bubbles on
      // every chat switch, so a container-scoped observer silently dies.
      this.observer = observer;
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'poster']
      });
    }

    stopObserving() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
    }

    getAll() {
      return Array.from(this.mediaItems.values());
    }

    getByType(type) {
      return this.getAll().filter(item => item.type === type);
    }

    getStats() {
      const all = this.getAll();
      return {
        total: all.length,
        photos: all.filter(i => i.type === 'photo').length,
        videos: all.filter(i => i.type === 'video').length,
        gifs: all.filter(i => i.type === 'gif' || i.type === 'animation').length,
        protectedCount: all.filter(i => i.isProtected).length,
        downloadable: all.filter(i => i.url).length
      };
    }

    clear() {
      this.mediaItems.clear();
      this.mediaElements.clear();
      this.imageBlobs.clear();
      this.dupDetector.clear();
    }
  }

  TME.MediaDetector = MediaDetector;
})();
