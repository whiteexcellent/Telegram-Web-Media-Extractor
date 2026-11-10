/**
 * ZIP Creator - Pure JavaScript ZIP file generator
 * Uses CompressionStream API for deflate compression (Chrome 80+)
 * No external dependencies required
 */
(function (root) {
  'use strict';

  const ZIP_SIGNATURE = {
    LOCAL_FILE: 0x04034b50,
    CENTRAL_DIR: 0x02014b50,
    END_OF_CENTRAL: 0x06054b50,
    DATA_DESCRIPTOR: 0x08074b50
  };

  class CRC32 {
    static table = null;

    static makeTable() {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
      }
      return table;
    }

    static compute(data) {
      if (!CRC32.table) CRC32.table = CRC32.makeTable();
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) {
        crc = CRC32.table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dateVal = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date: dateVal };
  }

  function stringToBytes(str) {
    return new TextEncoder().encode(str);
  }

  async function deflateData(data) {
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      const chunks = [];

      const readAll = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      })();

      writer.write(data);
      writer.close();
      await readAll;

      let totalLen = 0;
      for (const chunk of chunks) totalLen += chunk.length;
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch {
      return null;
    }
  }

  class ZipCreator {
    constructor() {
      this.files = [];
      this.offset = 0;
      this.parts = [];
    }

    async addFile(path, data, options = {}) {
      const fileData = data instanceof Uint8Array ? data : new Uint8Array(data);
      const nameBytes = stringToBytes(path);
      const crc = CRC32.compute(fileData);
      const uncompressedSize = fileData.length;
      const dt = dosDateTime(options.date);

      let compressedData = await deflateData(fileData);
      let compressionMethod = 8;

      if (!compressedData || compressedData.length >= uncompressedSize) {
        compressedData = fileData;
        compressionMethod = 0;
      }

      const compressedSize = compressedData.length;

      const localHeader = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(localHeader);
      lv.setUint32(0, ZIP_SIGNATURE.LOCAL_FILE, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, compressionMethod, true);
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, compressedSize, true);
      lv.setUint32(22, uncompressedSize, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      new Uint8Array(localHeader).set(nameBytes, 30);

      const headerOffset = this.offset;

      if (this.offset + localHeader.byteLength + compressedSize >= 0xffffffff || this.files.length >= 0xfffe) {
        throw new Error('Archive exceeds the ZIP32 size or entry limit');
      }
      this.parts.push(new Blob([localHeader, compressedData]));
      this.offset += localHeader.byteLength + compressedData.length;

      this.files.push({
        nameBytes,
        crc,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        dt,
        headerOffset
      });
    }

    finalize() {
      const centralDirOffset = this.offset;
      const centralParts = [];

      for (const file of this.files) {
        const cdHeader = new ArrayBuffer(46 + file.nameBytes.length);
        const cv = new DataView(cdHeader);
        cv.setUint32(0, ZIP_SIGNATURE.CENTRAL_DIR, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, file.compressionMethod, true);
        cv.setUint16(12, file.dt.time, true);
        cv.setUint16(14, file.dt.date, true);
        cv.setUint32(16, file.crc, true);
        cv.setUint32(20, file.compressedSize, true);
        cv.setUint32(24, file.uncompressedSize, true);
        cv.setUint16(28, file.nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0x20, true);
        cv.setUint32(42, file.headerOffset, true);
        new Uint8Array(cdHeader).set(file.nameBytes, 46);
        centralParts.push(new Uint8Array(cdHeader));
      }

      let centralDirSize = 0;
      for (const part of centralParts) centralDirSize += part.length;

      const endRecord = new ArrayBuffer(22);
      const ev = new DataView(endRecord);
      ev.setUint32(0, ZIP_SIGNATURE.END_OF_CENTRAL, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, this.files.length, true);
      ev.setUint16(10, this.files.length, true);
      ev.setUint32(12, centralDirSize, true);
      ev.setUint32(16, centralDirOffset, true);
      ev.setUint16(20, 0, true);

      if (centralDirOffset + centralDirSize + endRecord.byteLength >= 0xffffffff) {
        throw new Error('Archive exceeds the ZIP32 size limit');
      }
      return new Blob([...this.parts, ...centralParts, endRecord], { type: 'application/zip' });
    }

    getFileCount() {
      return this.files.length;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ZipCreator, CRC32 };
  } else {
    root.ZipCreator = ZipCreator;
    root.CRC32 = CRC32;
  }
})(typeof self !== 'undefined' ? self : this);
