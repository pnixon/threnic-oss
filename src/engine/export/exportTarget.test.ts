/**
 * exportTarget.test.ts
 *
 * ─── WHAT THESE TESTS PROTECT ──────────────────────────────────────────────
 * acquireExportTarget picks the best write sink per browser. The order matters
 * and each branch defends a real failure this export pipeline hit:
 *
 *   1. Chromium (File System Access API) — native Save dialog, streams to the
 *      chosen file. Regressing this loses direct-to-disk on Chrome.
 *   2. Firefox / Safari WITH OPFS — streams to an origin-private file (FLAT
 *      RAM), then downloads it by reference on close and deletes the temp file.
 *      This is what makes 4K / multi-hour exports viable on Firefox; regressing
 *      it drops the whole video back into RAM.
 *   3. No OPFS — last-resort in-memory Blob (small exports only).
 *   4. No WebCodecs at all — throws ExportUnsupported so the caller can show a
 *      clean message instead of crashing.
 *
 * OPFS presence is controlled per-test because it changes which sink is chosen.
 * If a test here fails after a refactor, a browser lost its correct sink — do
 * not relax the assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireExportTarget, ExportTargetAborted, ExportUnsupported } from './exportTarget';

interface FakeWin {
  showSaveFilePicker?: unknown;
  VideoEncoder?: unknown;
}
interface FakeNav {
  storage?: unknown;
}

const win = globalThis as unknown as FakeWin;
const nav = globalThis.navigator as unknown as FakeNav;

let originalPicker: unknown;
let originalEncoder: unknown;
let originalStorage: unknown;

/** Install a fake OPFS root that records writes/closes/removes so tests can
 *  assert streaming-to-disk, download-on-close, and cleanup. */
function installFakeOPFS() {
  const written: Uint8Array[] = [];
  let closed = false;
  const removed: string[] = [];

  const opfsWritable = {
    getWriter() {
      return {
        // mediabunny/OPFS positioned write command: { type, position, data }
        write: vi.fn(async (c: { type: 'write'; position: number; data: Uint8Array }) => {
          written.push(c.data);
        }),
        close: vi.fn(async () => {
          closed = true;
        }),
        abort: vi.fn(async () => {}),
      };
    },
  };

  const fileHandle = {
    createWritable: vi.fn(async () => opfsWritable),
    getFile: vi.fn(async () => {
      const size = written.reduce((n, c) => n + c.byteLength, 0);
      return new File([new Uint8Array(size)], 'x', { type: 'video/mp4' });
    }),
  };

  const root = {
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async (name: string) => {
      removed.push(name);
    }),
  };

  const storage = {
    getDirectory: vi.fn(async () => root),
    persist: vi.fn(async () => true),
  };
  nav.storage = storage;

  return { written, removed, getClosed: () => closed, storage, root, fileHandle };
}

describe('acquireExportTarget', () => {
  beforeEach(() => {
    originalPicker = win.showSaveFilePicker;
    originalEncoder = win.VideoEncoder;
    originalStorage = nav.storage;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPicker === undefined) delete win.showSaveFilePicker;
    else win.showSaveFilePicker = originalPicker;
    if (originalEncoder === undefined) delete win.VideoEncoder;
    else win.VideoEncoder = originalEncoder;
    // storage may be a non-configurable navigator prop in some envs; assign back.
    try {
      nav.storage = originalStorage;
    } catch {
      /* noop */
    }
    vi.restoreAllMocks();
  });

  it('streams direct-to-disk when the File System Access API is present (Chromium)', async () => {
    const fakeWritable = {} as WritableStream;
    const createWritable = vi.fn(async () => fakeWritable);
    win.showSaveFilePicker = vi.fn(async () => ({ createWritable }));

    const target = await acquireExportTarget('video.mp4');

    expect(win.showSaveFilePicker).toHaveBeenCalledOnce();
    expect(createWritable).toHaveBeenCalledOnce();
    expect(target.directToDisk).toBe(true);
    expect(target.sink).toBe('file-system-access');
    expect(target.writableStream).toBe(fakeWritable);
  });

  it('throws ExportTargetAborted when the user cancels the Save dialog', async () => {
    const abort = new Error('user cancelled');
    abort.name = 'AbortError';
    win.showSaveFilePicker = vi.fn(async () => {
      throw abort;
    });

    await expect(acquireExportTarget('video.mp4')).rejects.toBeInstanceOf(ExportTargetAborted);
  });

  it('STREAMS to OPFS (flat RAM) when the picker is absent but OPFS exists (Firefox)', async () => {
    // The core RAM fix: each chunk goes straight to the OPFS writer, never
    // accumulated in an array. directToDisk must be true and sink 'opfs'.
    delete win.showSaveFilePicker;
    win.VideoEncoder = class {};
    const opfs = installFakeOPFS();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const target = await acquireExportTarget('video.mp4');
    expect(target.sink).toBe('opfs');
    expect(target.directToDisk).toBe(true);
    expect(opfs.storage.persist).toHaveBeenCalled(); // requested persistence

    const writer = target.writableStream.getWriter();
    // mediabunny writes POSITIONED command objects, not raw bytes.
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3]) });
    await writer.write({ type: 'write', position: 3, data: new Uint8Array([4, 5]) });
    // Chunks were streamed to the OPFS writer as they arrived.
    expect(opfs.written.length).toBe(2);

    await writer.close();
    // On close it read the file back and triggered a download.
    expect(opfs.getClosed()).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();

    // Temp file is deleted after a delay to let the download start.
    expect(opfs.removed.length).toBe(0);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(opfs.removed.length).toBe(1);
  });

  it('deletes the OPFS temp file on abort', async () => {
    delete win.showSaveFilePicker;
    win.VideoEncoder = class {};
    const opfs = installFakeOPFS();

    const target = await acquireExportTarget('video.mp4');
    const writer = target.writableStream.getWriter();
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([1]) });
    await writer.abort(new Error('cancelled'));

    expect(opfs.removed.length).toBe(1);
  });

  it('falls back to a memory Blob download when OPFS is unavailable', async () => {
    // No OPFS (old Safari, private window with quota 0) → in-memory sink.
    delete win.showSaveFilePicker;
    win.VideoEncoder = class {};
    delete nav.storage;

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const target = await acquireExportTarget('video.mp4');
    expect(target.sink).toBe('memory');
    expect(target.directToDisk).toBe(false);

    const writer = target.writableStream.getWriter();
    // mediabunny streams mdat first, then may REWRITE the header at position 0.
    // The sink must place bytes by position, not append — appending (or
    // wrapping the command object in Uint8Array) is the 0-byte bug.
    await writer.write({ type: 'write', position: 4, data: new Uint8Array([10, 11]) });
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3, 4]) });
    await writer.close();

    expect(createURL).toHaveBeenCalledOnce();
    const blob = createURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    // Bytes assembled by position: [1,2,3,4] at 0, [10,11] at 4 → 6 bytes.
    expect(blob.size).toBe(6);
    expect(blob.type).toBe('video/mp4');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 10, 11]);
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the memory sink when opening OPFS THROWS', async () => {
    // OPFS present but getDirectory rejects (blocked / quota) — must not fail
    // the export, must degrade to memory.
    delete win.showSaveFilePicker;
    win.VideoEncoder = class {};
    nav.storage = { getDirectory: vi.fn(async () => Promise.reject(new Error('blocked'))) };

    const target = await acquireExportTarget('video.mp4');
    expect(target.sink).toBe('memory');
  });

  it('throws ExportUnsupported when WebCodecs is unavailable', async () => {
    delete win.showSaveFilePicker;
    delete win.VideoEncoder;

    await expect(acquireExportTarget('video.mp4')).rejects.toBeInstanceOf(ExportUnsupported);
  });
});
