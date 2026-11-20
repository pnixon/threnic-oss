import { describe, it, expect } from 'vitest';
import {
  chooseExportEngine,
  pickRecorderFormat,
  recorderFps,
  type EngineCaps,
} from './exportEngine';
import { recordedFileName, recorderBitrate } from './RealtimeRecorderController';

const caps = (over: Partial<EngineCaps>): EngineCaps => ({
  hasVideoEncoder: true,
  hasVideoFrame: true,
  hasAudioEncoder: true,
  canRecord: true,
  ...over,
});

describe('chooseExportEngine', () => {
  it('uses WebCodecs when video and audio can both be encoded', () => {
    expect(chooseExportEngine(caps({}))).toBe('webcodecs');
  });

  it('records in real time where WebCodecs is missing (Firefox for Android)', () => {
    expect(chooseExportEngine(caps({ hasVideoEncoder: false, hasAudioEncoder: false }))).toBe(
      'recorder',
    );
  });

  it('records in real time rather than silently dropping the soundtrack (Safari < 26)', () => {
    expect(chooseExportEngine(caps({ hasAudioEncoder: false }))).toBe('recorder');
  });

  it('falls back to video-only WebCodecs when recording is impossible', () => {
    expect(chooseExportEngine(caps({ hasAudioEncoder: false, canRecord: false }))).toBe(
      'webcodecs',
    );
  });

  it('ignores the audio encoder for exports without sound', () => {
    expect(chooseExportEngine(caps({ hasAudioEncoder: false }), false)).toBe('webcodecs');
  });

  it('reports none when nothing can export', () => {
    expect(
      chooseExportEngine(
        caps({ hasVideoEncoder: false, hasAudioEncoder: false, canRecord: false }),
      ),
    ).toBe('none');
    // VideoEncoder without VideoFrame is no use either.
    expect(chooseExportEngine(caps({ hasVideoFrame: false, canRecord: false }))).toBe('none');
  });
});

describe('pickRecorderFormat', () => {
  it('prefers MP4 when the browser records it (Safari)', () => {
    const f = pickRecorderFormat((t) => t.startsWith('video/mp4'));
    expect(f?.extension).toBe('mp4');
  });

  it('falls back to WebM (Firefox)', () => {
    const f = pickRecorderFormat((t) => t === 'video/webm;codecs=vp8,opus');
    expect(f).toEqual({ mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' });
  });

  it('returns null when nothing is supported or the check throws', () => {
    expect(pickRecorderFormat(() => false)).toBeNull();
    expect(
      pickRecorderFormat(() => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });
});

describe('recorderFps', () => {
  it('keeps 30 fps at 720p and below', () => {
    expect(recorderFps(1280, 720, 30)).toBe(30);
    expect(recorderFps(854, 480, 60)).toBe(30);
  });

  it('caps larger frames at 24 fps, which live encoders sustain', () => {
    expect(recorderFps(1920, 1080, 30)).toBe(24);
    expect(recorderFps(1920, 1080, 60)).toBe(24);
  });

  it('never raises the requested rate', () => {
    expect(recorderFps(1920, 1080, 24)).toBe(24);
    expect(recorderFps(1280, 720, 24)).toBe(24);
  });
});

describe('recorder file names and bitrate', () => {
  it('swaps the extension for the one actually recorded', () => {
    expect(recordedFileName('song_1920x1080_17.mp4', 'webm')).toBe('song_1920x1080_17.webm');
    expect(recordedFileName('My Track.v2', 'mp4')).toBe('My Track.mp4');
    expect(recordedFileName(undefined, 'webm')).toBe('threnic-export.webm');
  });

  it('keeps the live encoder bitrate within sane bounds', () => {
    expect(recorderBitrate(320, 180, 24)).toBe(2_500_000);
    expect(recorderBitrate(1920, 1080, 24)).toBeGreaterThan(10_000_000);
    expect(recorderBitrate(3840, 2160, 60)).toBe(24_000_000);
  });
});
