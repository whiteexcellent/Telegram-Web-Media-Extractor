(() => {
  'use strict';

  const decoder = new TextDecoder();

  async function read(file, offset, length) {
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  }

  function text(bytes, start, end) {
    return decoder.decode(bytes.subarray(start, end));
  }

  async function hasMp4Media(file) {
    let hasMovie = false;
    let hasMedia = false;
    for (let offset = 0; offset < file.size;) {
      const bytes = await read(file, offset, 16);
      if (bytes.length < 8) return false;
      const view = new DataView(bytes.buffer);
      const type = text(bytes, 4, 8);
      let size = view.getUint32(0);
      const headerSize = size === 1 ? 16 : 8;
      if (size === 1) {
        if (bytes.length < 16) return false;
        size = Number(view.getBigUint64(8));
      } else if (size === 0) {
        size = file.size - offset;
      }
      if (!Number.isSafeInteger(size) || size < headerSize || size > file.size - offset) return false;
      if (type === 'moov' && size > headerSize) hasMovie = true;
      if (type === 'mdat' && size > headerSize) hasMedia = true;
      offset += size;
    }
    return hasMovie && hasMedia;
  }

  async function validateMediaFile(file, { mediaType, expectedSize } = {}) {
    if (!file.size || (expectedSize && file.size !== expectedSize)) {
      throw new Error('ZIP entry is empty or its byte count does not match');
    }

    const head = await read(file, 0, 16);
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => head[index] === byte);
    const gif = /^GIF8[79]a$/.test(text(head, 0, 6));
    const webp = text(head, 0, 4) === 'RIFF' && text(head, 8, 12) === 'WEBP';
    if (mediaType !== 'video' && (jpeg || png || gif || webp)) return;

    if (mediaType !== 'photo') {
      const webm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      if (webm || await hasMp4Media(file)) return;
    }
    throw new Error('Invalid media file or incomplete video');
  }

  globalThis.TMEMediaValidation = { validateMediaFile };
})();
