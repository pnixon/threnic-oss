import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as idb from 'idb';

vi.mock('idb', () => ({
  openDB: vi.fn(),
}));

import { IDBPDatabase, OpenDBCallbacks } from 'idb';

describe('indexedDB utils', () => {
  let mockDB: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    objectStoreNames: { contains: ReturnType<typeof vi.fn> };
    createObjectStore: ReturnType<typeof vi.fn>;
  };
  let indexedDBUtils: typeof import('@/utils/indexedDB');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDB = {
      get: vi.fn(),
      put: vi.fn(),
      objectStoreNames: {
        contains: vi.fn().mockReturnValue(true),
      },
      createObjectStore: vi.fn(),
    };
    (idb.openDB as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string, version: number, { upgrade }: OpenDBCallbacks<any> = {}) => {
        if (upgrade) {
          (upgrade as any)(mockDB as unknown as IDBPDatabase<any>, 0, 0, null as any, null as any);
        }
        return Promise.resolve(mockDB);
      },
    );

    // Re-import to reset singleton
    indexedDBUtils = await import('@/utils/indexedDB');
  });

  describe('getDB', () => {
    it('should open the database', async () => {
      const db = await indexedDBUtils.getDB();
      expect(idb.openDB).toHaveBeenCalledWith('ThrenicDB', 2, expect.any(Object));
      expect(db).toBe(mockDB);
    });

    it('should only open the database once', async () => {
      await indexedDBUtils.getDB();
      await indexedDBUtils.getDB();
      expect(idb.openDB).toHaveBeenCalledTimes(1);
    });

    it('should create object store if it does not exist', async () => {
      const localMockDB = {
        objectStoreNames: { contains: vi.fn().mockReturnValue(false) },
        createObjectStore: vi.fn(),
      };
      (idb.openDB as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (n: string, v: number, { upgrade }: OpenDBCallbacks<any> = {}) => {
          if (upgrade)
            (upgrade as any)(
              localMockDB as unknown as IDBPDatabase<any>,
              0,
              0,
              null as any,
              null as any,
            );
          return Promise.resolve(localMockDB);
        },
      );
      vi.resetModules();
      const utils = await import('@/utils/indexedDB');
      await utils.getDB();
      expect(localMockDB.createObjectStore).toHaveBeenCalledWith('projects');
    });
  });

  describe('loadProjectFromIDB', () => {
    it('should return the project data from IDB', async () => {
      const mockData = { project: { name: 'Test' }, assets: {} };
      mockDB.get.mockResolvedValue(mockData);
      const result = await indexedDBUtils.loadProjectFromIDB();
      expect(result).toEqual(mockData);
    });

    it('should return null if no project exists', async () => {
      mockDB.get.mockResolvedValue(null);
      const result = await indexedDBUtils.loadProjectFromIDB();
      expect(result).toBeNull();
    });
  });

  describe('saveProjectToIDB', () => {
    const mockProject = { version: '1.4' } as unknown as any;
    const mockTracks = [
      {
        id: 'track-1',
        audioUrl: 'blob:audio-url',
        backgroundImage: 'blob:bg-url',
        audioFile: new File([], 'audio.mp3'),
        backgroundImageFile: new File([], 'bg.jpg'),
      },
    ] as unknown as any;

    it('should save project and assets to IDB', async () => {
      // Mock fetch for blobs
      const mockBlob = new Blob(['test'], { type: 'text/plain' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(mockBlob),
      });

      await indexedDBUtils.saveProjectToIDB(mockProject, mockTracks);

      expect(mockDB.put).toHaveBeenCalledWith(
        'projects',
        expect.objectContaining({
          project: mockProject,
          assets: expect.any(Object),
        }),
        'current_project',
      );

      const savedData = (mockDB.put.mock.calls[0] as unknown as any[])[1];
      expect(savedData.assets['track-1'].audioFile).toBeDefined();
      expect(savedData.assets['track-1'].backgroundImageFile).toBeDefined();
    });

    it('should handle fetch failures gracefully', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Fetch failed'));
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const tracksWithBlobsOnly = [
        {
          id: 'track-2',
          audioUrl: 'blob:audio-url',
          backgroundImage: 'blob:bg-url',
        },
      ] as any;

      await indexedDBUtils.saveProjectToIDB(mockProject, tracksWithBlobsOnly);

      expect(mockDB.put).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to fetch audio blob for IDB save',
        expect.any(Error),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to fetch background blob for IDB save',
        expect.any(Error),
      );

      consoleWarnSpy.mockRestore();
    });

    it('should store existing files without fetching', async () => {
      const tracksWithFiles = [
        {
          id: 'track-3',
          audioFile: new File(['audio'], 'audio.mp3'),
          backgroundImageFile: new File(['image'], 'image.jpg'),
        },
      ] as any;

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      await indexedDBUtils.saveProjectToIDB(mockProject, tracksWithFiles);

      expect(fetchSpy).not.toHaveBeenCalled();
      const savedData = (mockDB.put.mock.calls[0] as any)[1];
      expect(savedData.assets['track-3'].audioFile).toBeInstanceOf(File);
      expect(savedData.assets['track-3'].backgroundImageFile).toBeInstanceOf(File);
    });

    it('should handle track with lyrics data', async () => {
      const tracksWithLyrics = [
        {
          id: 'track-4',
          lyricsData: [{ text: 'hello' }],
        },
      ] as any;

      await indexedDBUtils.saveProjectToIDB(mockProject, tracksWithLyrics);
      const savedData = (mockDB.put.mock.calls[0] as any)[1];
      expect(savedData.assets['track-4']).toBeDefined();
    });

    it('should cover blob fetch lines in saveProjectToIDB', async () => {
      const mockBlob = new Blob(['test'], { type: 'audio/mpeg' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(mockBlob),
      });

      const tracksWithBlobs = [
        {
          id: 'track-5',
          audioUrl: 'blob:audio',
          backgroundImage: 'blob:bg',
        },
      ] as any;

      await indexedDBUtils.saveProjectToIDB(mockProject, tracksWithBlobs);

      const savedData = (mockDB.put.mock.calls[0] as any)[1];
      expect(savedData.assets['track-5'].audioFile).toBe(mockBlob);
      expect(savedData.assets['track-5'].backgroundImageFile).toBe(mockBlob);
    });
  });
});
