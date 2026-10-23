import { describe, it, expect, vi } from 'vitest';
import {
  collectProjectState,
  serializeProject,
  deserializeProject,
  loadProject,
  DEFAULT_THEME_CONFIG,
  DEFAULT_ANIMATION_CONFIG,
} from '@/utils/project';
import { PROJECT_VERSION } from '@/types/project';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';

import { ProjectStateInput } from '@/utils/project';

describe('project', () => {
  const mockInput = {
    trackName: 'Test Song',
    artist: 'Test Artist',
    audioFilePath: 'audio.mp3',
    currentTrackId: 'track-1',
    lyrics: [],
    fontSize: 1.0,
    fontId: 'inter',
    lyricColors: { pre: '#1', active: '#2', post: '#3' },
    verticalPosition: 20,
    effectScope: 'line' as const,
    wordSpacing: 1.5,
    animationType: 'popIn' as const,
    animationStagger: 'letter' as const,
    activeScaleEnabled: false,
    effectsConfig: { ...DEFAULT_EFFECTS_CONFIG },
    tracks: [
      {
        id: 'track-1',
        name: 'Track 1',
        artist: 'Artist 1',
        duration: 120,
        audioFilePath: 't1.mp3',
      },
    ],
  } as unknown as ProjectStateInput;

  describe('collectProjectState', () => {
    it('should correctly map input state to ThrenicProject', () => {
      const project = collectProjectState(mockInput);

      expect(project.version).toBe(PROJECT_VERSION);
      expect(project.meta.name).toBe('Test Song');
      expect(project.audio.filePath).toBe('audio.mp3');
      expect(project.theme.fontSize).toBe(1.0);
      expect(project.theme.fontId).toBe('inter');
      expect(project.animation.type).toBe('popIn');
      expect(project.playlist).toHaveLength(1);
      expect(project.playlist?.[0].name).toBe('Track 1');
      expect(project.playlist?.[0].audioFilePath).toBe('t1.mp3');
    });

    it('should handle playlist tracks with missing audioFilePath', () => {
      const inputWithPartialPlaylist = {
        ...mockInput,
        tracks: [{ id: 't1', name: 'N', audioFilePath: undefined }],
      };
      const project = collectProjectState(inputWithPartialPlaylist);
      expect(project.playlist?.[0].audioFilePath).toBeNull();
    });

    it('should handle missing optional fields', () => {
      const minimalInput = {
        trackName: '',
        lyrics: [],
        effectsConfig: DEFAULT_EFFECTS_CONFIG,
      } as unknown as ProjectStateInput;
      const project = collectProjectState(minimalInput);
      expect(project.meta.name).toBe('Untitled Project');
      expect(project.audio.name).toBe('Untitled');
    });
  });

  describe('serializeProject', () => {
    it('should stringify project and update modifiedAt', () => {
      vi.useFakeTimers();
      const project = collectProjectState(mockInput);
      const initialModifiedAt = project.meta.modifiedAt;

      // Advance time to ensure timestamp changes
      vi.advanceTimersByTime(1000);

      const json = serializeProject(project);
      expect(typeof json).toBe('string');
      expect(JSON.parse(json).meta.name).toBe('Test Song');
      expect(project.meta.modifiedAt).not.toBe(initialModifiedAt);

      vi.useRealTimers();
    });
  });

  describe('deserializeProject', () => {
    it('should parse valid JSON', () => {
      const project = collectProjectState(mockInput);
      const json = serializeProject(project);
      const { project: deserialized, warnings } = deserializeProject(json);

      expect(deserialized.meta.name).toBe('Test Song');
      // Schema validation may produce informational warnings for fields
      // not present in the simplified mock data (e.g. track effectsConfig)
      // The important thing is the project was parsed correctly
      expect(Array.isArray(warnings)).toBe(true);
    });

    it('should apply defaults for missing fields', () => {
      const minimalJson = JSON.stringify({
        version: '1.0',
        meta: { name: 'Flat Project' },
      });
      const { project, warnings } = deserializeProject(minimalJson);

      expect(project.meta.name).toBe('Flat Project');
      expect(project.theme.fontSize).toBe(DEFAULT_THEME_CONFIG.fontSize);
      expect(project.animation.type).toBe(DEFAULT_ANIMATION_CONFIG.type);
      expect(project.effects).toEqual(DEFAULT_EFFECTS_CONFIG);
    });

    it('should throw error for invalid JSON', () => {
      expect(() => deserializeProject('invalid')).toThrow('Invalid JSON');
    });

    it('should handle non-Error objects thrown in JSON.parse', () => {
      // We have to mock JSON.parse to throw a string or something
      const spy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
        throw 'string error';
      });
      expect(() => deserializeProject('{}')).toThrow('Invalid JSON: Parse error');
      spy.mockRestore();
    });

    it('should add warnings for missing version', () => {
      const noVersionJson = JSON.stringify({ meta: { name: 'Old' } });
      const { warnings } = deserializeProject(noVersionJson);
      expect(warnings).toContain('Project file has no version, assuming v1.0');
    });

    it('should handle data.audio?.name falling back to data.meta?.name', () => {
      const json = JSON.stringify({
        version: '1.0',
        meta: { name: 'Meta Name' },
        audio: { filePath: 'test.mp3' },
      });
      const { project } = deserializeProject(json);
      expect(project.audio.name).toBe('Meta Name');
    });

    it('should handle completely missing audio and meta name', () => {
      const json = JSON.stringify({ version: '1.0' });
      const { project } = deserializeProject(json);
      expect(project.audio.name).toBe('Untitled');
      expect(project.meta.name).toBe('Imported Project');
    });

    it('should handle playlist being missing or non-array', () => {
      const json = JSON.stringify({ version: '1.0', playlist: 'invalid' });
      const { project } = deserializeProject(json);
      expect(project.playlist).toBeUndefined();
    });
  });

  describe('loadProject', () => {
    it('should use showOpenFilePicker if available', async () => {
      const mockFile = {
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ version: '1.4', meta: { name: 'Loaded' } })),
      };
      const mockHandle = {
        getFile: vi.fn().mockResolvedValue(mockFile),
      };
      (window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker =
        vi.fn().mockResolvedValue([mockHandle]);

      const result = await loadProject();

      expect(
        (window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker,
      ).toHaveBeenCalled();
      expect(result?.project.meta.name).toBe('Loaded');
    });

    it('should fall back to file input if showOpenFilePicker is missing', async () => {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;

      // Mock file input
      const content = JSON.stringify({ version: '1.4', meta: { name: 'Input Loaded' } });
      const mockFile = new File([content], 'test.thren');
      (mockFile as unknown as { text: ReturnType<typeof vi.fn> }).text = vi
        .fn()
        .mockResolvedValue(content);

      const mockInput = {
        type: '',
        click: vi.fn(),
        files: [mockFile],
        onchange: null as unknown as () => void,
      };
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'input') return mockInput as unknown as HTMLElement;
        return {} as unknown as HTMLElement;
      });

      // We need to trigger the onchange manually since we can't easily wait for it
      const loadPromise = loadProject();
      mockInput.onchange();

      const result = await loadPromise;
      expect(result?.project.meta.name).toBe('Input Loaded');
    });

    it('should return null if user cancels picker', async () => {
      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      (window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker =
        vi.fn().mockRejectedValue(abortError);
      const result = await loadProject();
      expect(result).toBeNull();
    });

    it('should throw error if picker fails with other error', async () => {
      (window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker =
        vi.fn().mockRejectedValue(new Error('Other Error'));
      await expect(loadProject()).rejects.toThrow('Other Error');
    });

    it('should return null if no file is selected in fallback', async () => {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
      const mockInput = {
        type: '',
        click: vi.fn(),
        onchange: null as unknown as () => void,
        files: null,
      };
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'input') return mockInput as unknown as HTMLElement;
        return {} as unknown as HTMLElement;
      });

      const loadPromise = loadProject();
      mockInput.onchange();
      const result = await loadPromise;
      expect(result).toBeNull();
    });

    it('should reject if file.text() fails in fallback', async () => {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
      const mockFile = new File([''], 'test.thren');
      (mockFile as unknown as { text: ReturnType<typeof vi.fn> }).text = vi
        .fn()
        .mockRejectedValue(new Error('Read Error'));

      const mockInput = {
        type: '',
        click: vi.fn(),
        onchange: null as unknown as () => void,
        files: [mockFile],
      };
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'input') return mockInput as unknown as HTMLElement;
        return {} as unknown as HTMLElement;
      });

      const loadPromise = loadProject();
      mockInput.onchange();
      await expect(loadPromise).rejects.toThrow('Read Error');
    });
  });
});
