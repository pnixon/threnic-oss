/**
 * Cross-browser export write-target acquisition.
 *
 * The direct-to-disk export path relies on the File System Access API
 * (`window.showSaveFilePicker` → `FileSystemWritableFileStream`), which is
 * Chromium-only. Firefox and Safari do not implement the arbitrary-path picker,
 * so calling it throws `TypeError: window.showSaveFilePicker is not a function`.
 *
 * This helper returns a `WritableStream<Uint8Array>` for the exporter to write
 * MP4 bytes into, regardless of browser, choosing the best available sink:
 *
 *   • Chromium (File System Access API) — prompts the native Save dialog and
 *     streams straight to the user's chosen file. No memory ceiling.
 *
 *   • Firefox / Safari WITH OPFS (Origin Private File System) — streams every
 *     chunk to an origin-private file via createWritable(). RAM stays FLAT
 *     during a multi-hour encode; when the stream closes we read the finished
 *     file back BY REFERENCE (URL.createObjectURL over the OPFS File does not
 *     copy it into RAM) and trigger a normal download, then delete the temp
 *     file to reclaim quota. This is the path that makes 4K / 8-hour exports
 *     viable on Firefox — the ceiling moves from RAM to disk quota.
 *
 *   • Anything without OPFS — last-resort in-memory buffer + Blob download.
 *     The whole video sits in RAM until close; acceptable only for small
 *     exports.
 *
 * The returned stream is a plain `WritableStream`, which is exactly what
 * `DecoupledExporter.run()` expects — a real `FileSystemWritableFileStream`
 * is itself a `WritableStream`, so every path is interchangeable downstream.
 */

/**
 * The command shape mediabunny's `StreamTarget` writes into the WritableStream.
 * It is a POSITIONED write ({ type, data, position }) — the same command object
 * accepted by File System Access / OPFS `FileSystemWritableFileStream.write()`.
 * Our custom sinks (OPFS, memory) MUST honor `position`, not treat the chunk as
 * raw bytes — doing the latter writes a zero-length array and yields a 0-byte
 * output file (the Firefox "Completed — 0 bytes" bug).
 */
interface StreamTargetChunk {
  type: 'write';
  data: Uint8Array;
  position: number;
}

/** OPFS/FSA positioned write-command params object. */
interface FsWriteCommand {
  type: 'write';
  position: number;
  data: Uint8Array;
}

interface ExportTarget {
  /** Stream the exporter writes MP4 bytes into. */
  writableStream: WritableStream;
  /** true when bytes go to disk incrementally (Chromium picker OR OPFS) rather
   *  than being held in RAM until close. */
  directToDisk: boolean;
  /** How the target was acquired — for accurate user messaging. */
  sink: 'file-system-access' | 'opfs' | 'memory';
}

/** Aborted by the user at the Save dialog — callers should quietly return. */
export class ExportTargetAborted extends Error {
  constructor() {
    super('Export target selection aborted by user');
    this.name = 'ExportTargetAborted';
  }
}

/**
 * This browser cannot run a WebCodecs MP4 export (e.g. Firefox: it exposes
 * VideoEncoder but throws NotSupportedError at encode time). Callers should
 * show a clear "use Chrome/Edge" message.
 */
export class ExportUnsupported extends Error {
  constructor() {
    super('Video export is not supported in this browser');
    this.name = 'ExportUnsupported';
  }
}

function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  );
}

/**
 * Trigger a plain-anchor download of a Blob. Used by the memory-buffered
 * fallback and cleaned up after the browser has had a chance to start the
 * download.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has committed to the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** True when the Origin Private File System is available with a createWritable
 *  path (Firefox and Safari have it; it is the writable-file half of the File
 *  System Access API that IS allowed off Chromium, because it is sandboxed to
 *  the origin rather than pointing at an arbitrary user path). */
function supportsOPFS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/** A unique temp name in OPFS so concurrent/aborted exports never collide. */
function opfsTempName(suggestedName: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `.threnic-export-${stamp}-${suggestedName}`;
}

/**
 * Build a WritableStream that streams MP4 bytes to an origin-private file, and
 * on close reads that file back BY REFERENCE and triggers a download, then
 * deletes it. RAM stays flat throughout; the ceiling is the origin storage
 * quota (request persistence with navigator.storage.persist()).
 *
 * Throws if OPFS cannot be opened, so the caller can fall back to the memory
 * sink.
 */
async function makeOpfsStream(suggestedName: string, mimeType: string): Promise<WritableStream> {
  const root = await navigator.storage.getDirectory();
  const tempName = opfsTempName(suggestedName);
  const fileHandle = await root.getFileHandle(tempName, { create: true });
  // createWritable() on an OPFS handle is supported in Firefox/Safari (unlike
  // showSaveFilePicker). Truncate any prior content with keepExistingData:false.
  const opfsWritable = (await (
    fileHandle as unknown as {
      createWritable: (opts?: {
        keepExistingData?: boolean;
      }) => Promise<WritableStream<FsWriteCommand>>;
    }
  ).createWritable({ keepExistingData: false })) as WritableStream<FsWriteCommand>;

  const writer = opfsWritable.getWriter();

  const cleanup = async () => {
    try {
      await root.removeEntry(tempName);
    } catch {
      /* the browser reclaims OPFS on quota pressure anyway */
    }
  };

  return new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      // mediabunny's StreamTarget writes POSITIONED command objects
      // ({ type: 'write', data, position }) — NOT raw bytes. An OPFS
      // FileSystemWritableFileStream understands exactly this write-command
      // shape (same as the File System Access API), so forward it verbatim.
      // Copy the data defensively since the encoder may reuse the backing
      // buffer after write() returns.
      await writer.write({
        type: 'write',
        position: chunk.position,
        data: new Uint8Array(chunk.data),
      });
    },
    async close() {
      await writer.close();
      // Read the finished file back. getFile() → File is a reference into OPFS;
      // createObjectURL over it does NOT load the bytes into RAM, so the
      // download streams from disk.
      const file = await fileHandle.getFile();
      const blob = mimeType && file.type !== mimeType ? file.slice(0, file.size, mimeType) : file;
      downloadBlob(blob, suggestedName);
      // Give the download manager time to open the object URL before deleting
      // the backing OPFS file (revoke + removeEntry happen well after the read
      // has started).
      setTimeout(() => void cleanup(), 90_000);
    },
    async abort() {
      try {
        await writer.abort();
      } catch {
        /* noop */
      }
      await cleanup();
    },
  });
}

/**
 * Acquire an export write target. On Chromium this MUST be called synchronously
 * within the user gesture (the click handler) so the Save dialog is allowed to
 * open — do not await anything before it.
 *
 * @param suggestedName Default file name (e.g. `export.mp4`).
 * @param mimeType      Output MIME type (default `video/mp4`).
 */
export async function acquireExportTarget(
  suggestedName: string,
  mimeType = 'video/mp4',
): Promise<ExportTarget> {
  if (supportsFileSystemAccess()) {
    let handle: FileSystemFileHandle;
    try {
      handle = await (
        window as unknown as {
          showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'MP4 Video File',
            accept: { [mimeType]: ['.mp4'] },
          },
        ],
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExportTargetAborted();
      }
      throw err;
    }
    const writableStream = (await (
      handle as unknown as { createWritable: () => Promise<WritableStream> }
    ).createWritable()) as WritableStream;
    return { writableStream, directToDisk: true, sink: 'file-system-access' };
  }

  // ── Fallback: buffer in memory, download a Blob on close ──
  // WebCodecs itself must be present. Whether a usable codec exists is decided
  // by the exporter's real negotiation (which validates configure()), not
  // guessed here — modern Firefox (130+) encodes H.264 in software and works.
  if (typeof VideoEncoder === 'undefined') {
    throw new ExportUnsupported();
  }

  // ── Preferred fallback: stream to OPFS (flat RAM) ──
  // This is what makes long / 4K exports viable on Firefox. Request storage
  // persistence so the browser is less likely to evict the temp file under
  // quota pressure mid-encode (best-effort — a denial is non-fatal).
  if (supportsOPFS()) {
    try {
      if (typeof navigator.storage.persist === 'function') {
        await navigator.storage.persist().catch(() => false);
      }
      const writableStream = await makeOpfsStream(suggestedName, mimeType);
      return { writableStream, directToDisk: true, sink: 'opfs' };
    } catch {
      // OPFS unavailable or blocked (private-window quota=0, etc.) — fall
      // through to the in-memory sink below.
    }
  }

  // ── Last-resort fallback: buffer in memory, download a Blob on close ──
  // The whole video sits in RAM until close; acceptable only for small exports.
  // mediabunny writes POSITIONED chunks and may rewrite the header region
  // (moov/ftyp) at position 0 AFTER streaming the mdat, so we cannot simply
  // append — we place each chunk's bytes at its declared position in a
  // growable buffer.
  let buffer = new Uint8Array(0);
  let highWater = 0;
  const ensureCapacity = (needed: number) => {
    if (needed <= buffer.length) return;
    // Grow geometrically to avoid O(n^2) reallocations on many small writes.
    let newLen = buffer.length === 0 ? 1 << 20 : buffer.length;
    while (newLen < needed) newLen *= 2;
    const grown = new Uint8Array(newLen);
    grown.set(buffer);
    buffer = grown;
  };
  const writableStream = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const end = chunk.position + chunk.data.length;
      ensureCapacity(end);
      buffer.set(chunk.data, chunk.position);
      if (end > highWater) highWater = end;
    },
    close() {
      const blob = new Blob([buffer.subarray(0, highWater)], { type: mimeType });
      downloadBlob(blob, suggestedName);
      buffer = new Uint8Array(0);
      highWater = 0;
    },
    abort() {
      buffer = new Uint8Array(0);
      highWater = 0;
    },
  });

  return { writableStream, directToDisk: false, sink: 'memory' };
}
