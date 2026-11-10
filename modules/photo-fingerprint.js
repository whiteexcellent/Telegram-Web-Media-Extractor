(() => {
  'use strict';

  const GRID = 32;
  const BYTE_COUNT = GRID * GRID * 4;

  function describe(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = GRID;
    canvas.height = GRID;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, GRID, GRID);
    const { data } = context.getImageData(0, 0, GRID, GRID);
    return { aspect: width / height, pixels: btoa(String.fromCharCode(...data)) };
  }

  function decode(fingerprint) {
    if (!fingerprint || !Number.isFinite(fingerprint.aspect) || fingerprint.aspect <= 0 ||
        typeof fingerprint.pixels !== 'string' || fingerprint.pixels.length !== Math.ceil(BYTE_COUNT / 3) * 4) {
      return null;
    }
    try {
      const raw = atob(fingerprint.pixels);
      if (raw.length !== BYTE_COUNT) return null;
      const pixels = Uint8Array.from(raw, char => char.charCodeAt(0));
      const average = pixels.reduce((sum, value) => sum + value, 0) / BYTE_COUNT;
      return { aspect: fingerprint.aspect, pixels, average };
    } catch {
      return null;
    }
  }

  function matches(a, b) {
    if (Math.abs(Math.log(a.aspect / b.aspect)) > 0.012 || Math.abs(a.average - b.average) > 2.5) return false;
    let total = 0;
    let outliers = 0;
    for (let index = 0; index < BYTE_COUNT; index++) {
      const delta = Math.abs(a.pixels[index] - b.pixels[index]);
      total += delta;
      if (delta > 20) outliers++;
      if (total > BYTE_COUNT * 2.5 || outliers > 12) return false;
    }
    return true;
  }

  globalThis.TMEPhotoFingerprint = { describe, decode, matches };
})();
