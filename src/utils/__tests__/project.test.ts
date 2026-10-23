/**
 * Tests for deserializeProject — specifically the tracks/playlist key handling
 * and the overall deserialization pipeline.
 */
import { describe, it, expect } from 'vitest';
import { deserializeProject } from '../project';

// Minimal valid project structure for testing
function makeMinimalProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { name: 'Test Project' },
    audio: { filePath: null, name: 'Test' },
    backgroundImage: { filePath: null },
    lyrics: { lines: [], filePath: null },
    theme: {},
    animation: {},
    effects: {},
    ...overrides,
  };
}

function makeTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'track-1',
    name: 'Test Track',
    artist: 'Artist',
    duration: 60,
    audioFilePath: '/audio.mp3',
    effectsConfig: {},
    ...overrides,
  };
}

describe('deserializeProject', () => {
  describe('playlist vs tracks key handling', () => {
    it('should parse tracks from "playlist" key (legacy/IDB format)', () => {
      const json = JSON.stringify(
        makeMinimalProject({
          playlist: [
            makeTrack({ id: 'p1', name: 'Playlist Track 1' }),
            makeTrack({ id: 'p2', name: 'Playlist Track 2' }),
          ],
        }),
      );

      const { project } = deserializeProject(json);

      expect(project.playlist).toBeDefined();
      expect(project.playlist).toHaveLength(2);
      expect(project.playlist![0].name).toBe('Playlist Track 1');
      expect(project.playlist![1].name).toBe('Playlist Track 2');
    });

    it('should parse tracks from "tracks" key (newer JSON format)', () => {
      const json = JSON.stringify(
        makeMinimalProject({
          tracks: [
            makeTrack({ id: 't1', name: 'Track 1' }),
            makeTrack({ id: 't2', name: 'Track 2' }),
          ],
        }),
      );

      const { project } = deserializeProject(json);

      expect(project.playlist).toBeDefined();
      expect(project.playlist).toHaveLength(2);
      expect(project.playlist![0].name).toBe('Track 1');
      expect(project.playlist![1].name).toBe('Track 2');
    });

    it('should prefer "playlist" over "tracks" when both exist', () => {
      const json = JSON.stringify(
        makeMinimalProject({
          playlist: [makeTrack({ id: 'p1', name: 'From Playlist' })],
          tracks: [makeTrack({ id: 't1', name: 'From Tracks' })],
        }),
      );

      const { project } = deserializeProject(json);

      expect(project.playlist).toHaveLength(1);
      expect(project.playlist![0].name).toBe('From Playlist');
    });

    it('should return undefined playlist when neither key exists', () => {
      const json = JSON.stringify(makeMinimalProject());

      const { project } = deserializeProject(json);

      expect(project.playlist).toBeUndefined();
    });
  });

  describe('effects migration', () => {
    it('should migrate legacy effects config in playlist tracks', () => {
      const legacyEffects = {
        particles: { enabled: true, count: 500 },
        postProcessing: {
          bloom: { enabled: true, intensity: 0.5 },
        },
      };

      const json = JSON.stringify(
        makeMinimalProject({
          tracks: [makeTrack({ effectsConfig: legacyEffects })],
        }),
      );

      const { project } = deserializeProject(json);

      // migrateLegacyEffects should have run — check that effectInstances exist
      // (the migration converts old particles/postProcessing to effectInstances)
      expect(project.playlist).toBeDefined();
      expect(project.playlist![0].effectsConfig).toBeDefined();
      // The migrated config should have effectInstances array
      expect(project.playlist![0].effectsConfig.effectInstances).toBeDefined();
    });
  });

  describe('basic deserialization', () => {
    it('should populate required fields with defaults', () => {
      const json = JSON.stringify({ version: '1.0', meta: { name: 'Minimal' } });

      const { project } = deserializeProject(json);

      expect(project.version).toBe('1.0');
      expect(project.meta.name).toBe('Minimal');
      expect(project.audio.filePath).toBeNull();
      expect(project.backgroundImage.filePath).toBeNull();
      expect(project.lyrics.lines).toEqual([]);
      expect(project.theme).toBeDefined();
      expect(project.animation).toBeDefined();
      expect(project.effects).toBeDefined();
    });

    it('should preserve track IDs through deserialization', () => {
      const json = JSON.stringify(
        makeMinimalProject({
          tracks: [makeTrack({ id: 'custom-id-123' })],
        }),
      );

      const { project } = deserializeProject(json);

      expect(project.playlist![0].id).toBe('custom-id-123');
    });

    it('should preserve lyricsTheme on tracks', () => {
      const theme = {
        fontSize: 1.2,
        fontId: 'inter',
        colors: { pre: '#aaa', active: '#fff', post: '#666' },
        verticalPosition: 80,
      };

      const json = JSON.stringify(
        makeMinimalProject({
          tracks: [makeTrack({ lyricsTheme: theme })],
        }),
      );

      const { project } = deserializeProject(json);

      expect(project.playlist![0].lyricsTheme).toEqual(theme);
    });

    it('should throw on invalid JSON', () => {
      expect(() => deserializeProject('not json')).toThrow('Invalid JSON');
    });
  });
});
