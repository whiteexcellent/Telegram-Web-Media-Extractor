(() => {
  'use strict';

  function byteCount(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }

  function responseExtent(response, offset = 0, expected = 0) {
    const length = byteCount(response.headers.get('content-length'));
    if (response.status === 200 && offset === 0) {
      const unencodedLength = response.headers.get('content-encoding') ? 0 : length;
      if (unencodedLength && expected && unencodedLength !== expected) {
        throw new Error(`Media size does not match (${unencodedLength}/${expected} bytes)`);
      }
      const total = expected || unencodedLength;
      return { total, length: total };
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
    const start = Number(range?.[1]);
    const end = Number(range?.[2]);
    const declaredTotal = byteCount(range?.[3]);
    const total = declaredTotal || expected;
    const rangeLength = end - start + 1;
    if (response.status !== 206 || start !== offset || !Number.isSafeInteger(end) || end < start ||
        !total || end >= total || (expected && total !== expected) || (length && length !== rangeLength)) {
      throw new Error('Invalid byte range or unknown total media size');
    }
    return { total, length: rangeLength };
  }

  async function fetchStreamFile(request, { size, onStart, onChunk, allowPartial }) {
    let offset = 0;
    let total = byteCount(size);
    do {
      const response = await request(`bytes=${offset}-`);
      const reader = response.body?.getReader();
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const extent = responseExtent(response, offset, total);
        total = extent.total;
        if (!allowPartial && extent.length !== total) throw new Error('Media source returned only a partial file');
        if (offset === 0) await onStart(response, total);

        let received = 0;
        const push = async (bytes) => {
          received += bytes.byteLength;
          if (extent.length && received > extent.length) throw new Error('Media response exceeded its declared byte range');
          await onChunk(bytes);
        };
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength) await push(value);
          }
        } else {
          await push(new Uint8Array(await response.arrayBuffer()));
        }
        if (!received || (extent.length && received !== extent.length)) {
          throw new Error('Media response ended before its declared byte count');
        }
        offset += received;
      } catch (error) {
        await reader?.cancel().catch(() => {});
        throw error;
      } finally {
        reader?.releaseLock();
      }
    } while (offset < total);
    return offset;
  }

  async function fetchMediaBlob(url, { fetch, stream, size, mime, signal }) {
    const chunks = [];
    let type = mime || '';
    await fetchStreamFile(
      (range) => fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        ...(stream ? { cache: 'no-store', headers: { Range: range } } : {}),
        signal
      }),
      {
        size,
        allowPartial: stream,
        onStart(response) {
          type ||= response.headers.get('content-type') || '';
        },
        onChunk(bytes) {
          chunks.push(bytes);
        }
      }
    );
    return new Blob(chunks, { type });
  }

  globalThis.TMEMediaResponse = { fetchMediaBlob };
})();
