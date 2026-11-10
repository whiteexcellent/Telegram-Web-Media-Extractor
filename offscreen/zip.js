/**
 * Offscreen ZIP Worker — queued streaming ZIP assembly
 * Files are handed over one-by-one from the service worker and packed
 * sequentially, so the ZIP grows incrementally instead of buffering
 * every downloaded file in memory at once.
 */
let zip = null;
let started = false;
let totalFiles = 0;
let processed = 0;
const fileQueue = [];
const largeFiles = new Map();
const packedKeys = new Set();
let draining = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'OFFSCREEN_START_ZIP': {
      zip = new ZipCreator();
      started = true;
      totalFiles = (msg.data && msg.data.totalFiles) || 0;
      processed = 0;
      fileQueue.length = 0;
      largeFiles.clear();
      packedKeys.clear();
      sendResponse({ ok: true });
      return true;
    }
    case 'OFFSCREEN_ADD_FILE': {
      enqueueFile({ ...msg.data, chunks: msg.data.data, respond: sendResponse });
      return true;
    }
    case 'OFFSCREEN_FILE_START': {
      const { requestId, ...data } = msg.data;
      largeFiles.set(requestId, { ...data, chunks: [] });
      sendResponse({ ok: true });
      return true;
    }
    case 'OFFSCREEN_FILE_CHUNK': {
      const file = largeFiles.get(msg.data.requestId);
      if (!file) {
        sendResponse({ error: 'Unknown ZIP entry' });
        return true;
      }
      file.chunks.push(Uint8Array.from(msg.data.chunk));
      sendResponse({ ok: true });
      return true;
    }
    case 'OFFSCREEN_FILE_END': {
      const file = largeFiles.get(msg.data.requestId);
      if (!file) {
        sendResponse({ error: 'Unknown ZIP entry' });
        return true;
      }
      largeFiles.delete(msg.data.requestId);
      enqueueFile({ ...file, respond: sendResponse });
      return true;
    }
    case 'OFFSCREEN_FILE_ABORT': {
      largeFiles.delete(msg.data.requestId);
      sendResponse({ ok: true });
      return true;
    }
    case 'OFFSCREEN_RELEASE_URL': {
      try {
        URL.revokeObjectURL(msg.data && msg.data.blobUrl);
      } catch {}
      sendResponse({ ok: true });
      return true;
    }
    case 'OFFSCREEN_FINISH_ZIP': {
      sendResponse({ ok: true });
      finish(msg.data && msg.data.manifest);
      return true;
    }
  }
});

function enqueueFile(file) {
  if (!started) {
    file.respond({ error: 'ZIP not started' });
    return;
  }
  fileQueue.push(file);
  drain();
}

function deChunk(chunks) {
  let total = 0;
  for (const c of chunks) total += (c && c.length) || 0;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    if (c && c.length) {
      out.set(c, off);
      off += c.length;
    }
  }
  return out;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (fileQueue.length > 0) {
      const job = fileQueue.shift();
      try {
        const bytes = deChunk(job.chunks);
        await globalThis.TMEMediaValidation.validateMediaFile(new Blob([bytes]), {
          mediaType: job.mediaType,
          expectedSize: job.size
        });
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (packedKeys.has(key)) {
          job.respond({ ok: true, duplicate: true });
          continue;
        }
        await zip.addFile(job.path, bytes);
        packedKeys.add(key);
        processed++;
        job.respond({ ok: true });
      } catch (error) {
        job.respond({ error: error.message });
      }
      reportProgress();
    }
  } finally {
    draining = false;
  }
}

async function finish(manifest) {
  try {
    // wait until the queue and in-flight adds are fully consumed
    await waitDrained();
    if (!zip) throw new Error('No ZIP started');

    const manifestJson = JSON.stringify(manifest || {}, null, 2);
    await zip.addFile('Telegram_Export/Metadata/manifest.json',
      new TextEncoder().encode(manifestJson));

    const zipBlob = zip.finalize();
    zip = null;
    started = false;

    // MV3 service workers have no URL.createObjectURL — create the blob URL
    // HERE (offscreen has full DOM) and hand the string to the worker for
    // chrome.downloads.download().
    const blobUrl = URL.createObjectURL(zipBlob);

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const filename = `Telegram_${manifest?.retry ? 'Recovery' : 'Export'}_${dateStr}.zip`;

    // safety net: never keep the blob alive more than 10 minutes
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch {}
    }, 10 * 60 * 1000);

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ZIP_READY',
      data: { blobUrl, filename, size: zipBlob.size, fileCount: processed }
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ZIP_ERROR',
      data: { error: err.message }
    });
  }
}

function waitDrained() {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!draining && fileQueue.length === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

function reportProgress() {
  const pct = totalFiles > 0
    ? Math.min(99, Math.round((processed / totalFiles) * 100))
    : Math.min(99, processed * 2);
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_ZIP_PROGRESS',
    data: {
      progress: pct,
      details: `Packaging ${processed} of ${totalFiles || processed + fileQueue.length} files...`
    }
  });
}
