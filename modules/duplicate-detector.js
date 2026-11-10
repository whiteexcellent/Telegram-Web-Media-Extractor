/**
 * Duplicate Detector Module
 * Prevents duplicate media items from being added to the collection
 */
(function () {
  'use strict';
  const TME = window.TelegramMediaExtractor = window.TelegramMediaExtractor || {};

  class DuplicateDetector {
    constructor() {
      this.byUrl = new Map();
      this.byAttachment = new Map();
      this.byStream = new Map();
      this.byDocument = new Map();
    }

    find(item) {
      return this.byUrl.get(item.url) ||
        (item.streamKey && this.byStream.get(item.streamKey)) ||
        (item.documentId && this.byDocument.get(item.documentId)) ||
        (item.attachmentKey && this.byAttachment.get(item.attachmentKey));
    }

    add(item) {
      if (item.url) this.byUrl.set(item.url, item);
      if (item.documentId) this.byDocument.set(item.documentId, item);
      if (item.attachmentKey) this.byAttachment.set(item.attachmentKey, item);
      if (item.streamKey) this.byStream.set(item.streamKey, item);
    }

    remove(item) {
      if (!item) return;
      if (this.byDocument.get(item.documentId) === item) this.byDocument.delete(item.documentId);
      if (this.byUrl.get(item.url) === item) this.byUrl.delete(item.url);
      if (this.byAttachment.get(item.attachmentKey) === item) this.byAttachment.delete(item.attachmentKey);
      if (this.byStream.get(item.streamKey) === item) this.byStream.delete(item.streamKey);
    }

    clear() {
      this.byUrl.clear();
      this.byAttachment.clear();
      this.byStream.clear();
      this.byDocument.clear();
    }
  }

  TME.DuplicateDetector = DuplicateDetector;
})();
