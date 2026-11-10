/**
 * Chat Scanner Module
 * Scrolls through Telegram chat to discover all media content
 */
(function () {
  'use strict';
  const TME = window.TelegramMediaExtractor = window.TelegramMediaExtractor || {};

  const SCAN_DELAY_MS = 320;
  const SCROLL_STEP_PX = 1200;
  const MAX_RETRIES = 3;
  const STALE_THRESHOLD = 4;

  class ChatScanner {
    constructor(detector) {
      this.detector = detector;
      this.isScanning = false;
      this.shouldStop = false;
      this.progress = { scanned: 0, found: 0, status: 'idle' };
      this.onProgress = null;
      this.onComplete = null;
    }

    getScrollContainer() {
      const version = TME.MediaParser.detectVersion();
      const selectors = version === 'K'
        ? ['.bubbles', '.scrollable-y', '.chat .scrollable']
        : ['.MessageList', '.messages-container .scrollable', '#MiddleColumn .scrollable'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) return el;
      }
      const all = document.querySelectorAll('.scrollable, .scrollable-y, [class*="scroll"]');
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 100) return el;
      }
      return null;
    }

    async scan(direction = 'up') {
      if (this.isScanning) return;
      this.isScanning = true;
      this.shouldStop = false;
      this.progress = { scanned: 0, found: 0, status: 'scanning' };
      this._report();

      this._scanMedia();
      this.progress.found = this.detector.getAll().length;
      this._report();

      const container = this.getScrollContainer();
      if (!container) {
        this.progress.status = 'no_scroll_container';
        this.isScanning = false;
        this._report();
        if (this.onComplete) this.onComplete(this.progress);
        return;
      }

      let staleCount = 0;
      let retries = 0;
      let lastCount = this.detector.getAll().length;

      while (!this.shouldStop) {
        const prevScrollTop = container.scrollTop;
        if (direction === 'up') {
          container.scrollTop = Math.max(0, container.scrollTop - SCROLL_STEP_PX);
        } else {
          container.scrollTop += SCROLL_STEP_PX;
        }
        this.progress.scanned++;

        await this._wait(SCAN_DELAY_MS);

        this._scanMedia();
        const currentCount = this.detector.getAll().length;

        if (currentCount > lastCount) {
          staleCount = 0;
          retries = 0;
          lastCount = currentCount;
        } else {
          staleCount++;
        }

        this.progress.found = currentCount;
        this._report();

        if (direction === 'up' && container.scrollTop <= 0) {
          retries++;
          if (retries >= MAX_RETRIES) {
            this.progress.status = 'reached_top';
            break;
          }
          await this._wait(700);
        } else if (direction === 'down' &&
                   container.scrollTop + container.clientHeight >= container.scrollHeight - 10) {
          retries++;
          if (retries >= MAX_RETRIES) {
            this.progress.status = 'reached_bottom';
            break;
          }
          await this._wait(700);
        }

        if (staleCount >= STALE_THRESHOLD) {
          retries++;
          if (retries >= MAX_RETRIES) {
            this.progress.status = 'no_new_media';
            break;
          }
          staleCount = 0;
          await this._wait(900);
        }
      }

      if (this.shouldStop) {
        this.progress.status = 'stopped';
      } else if (this.progress.status === 'scanning') {
        this.progress.status = 'complete';
      }

      this.isScanning = false;
      this._report();
      if (this.onComplete) this.onComplete(this.progress);
    }

    stop() {
      this.shouldStop = true;
    }

    _scanMedia() {
      const items = this.detector.scanDocument();
      if (items.length) this.detector.onMediaFound?.(items);
    }

    _report() {
      if (this.onProgress) this.onProgress({ ...this.progress });
    }

    _wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    getProgress() {
      return { ...this.progress };
    }
  }

  TME.ChatScanner = ChatScanner;
})();
