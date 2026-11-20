/**
 * Which export engine this browser can use.
 *
 *  - 'webcodecs': offline, faster than real time, MP4 via mediabunny. Needs
 *    VideoEncoder and VideoFrame, and AudioEncoder when the export has sound.
 *  - 'recorder': real-time capture of the rendered frames with MediaRecorder.
 *    Takes as long as the video itself, but works where WebCodecs is missing
 *    (Firefox for Android) or incomplete (Safari before 26 has no AudioEncoder,
 *    so the offline path would silently drop the soundtrack).
 *  - 'none': neither is available.
 */

export type ExportEngine = 'webcodecs' | 'recorder' | 'none';

export interface EngineCaps {
  hasVideoEncoder: boolean;
  hasVideoFrame: boolean;
  hasAudioEncoder: boolean;
  canRecord: boolean;
}

export function detectEngineCaps(): EngineCaps {
  const g = globalThis as unknown as Record<string, unknown>;
  const canvasProto =
    typeof HTMLCanvasElement !== 'undefined' ? HTMLCanvasElement.prototype : undefined;
  return {
    hasVideoEncoder: typeof g.VideoEncoder !== 'undefined',
    hasVideoFrame: typeof g.VideoFrame !== 'undefined',
    hasAudioEncoder: typeof g.AudioEncoder !== 'undefined',
    canRecord:
      typeof g.MediaRecorder !== 'undefined' &&
      typeof g.AudioContext !== 'undefined' &&
      !!canvasProto &&
      typeof canvasProto.captureStream === 'function' &&
      pickRecorderFormat() !== null,
  };
}

export function chooseExportEngine(caps: EngineCaps, withAudio = true): ExportEngine {
  const offlineVideo = caps.hasVideoEncoder && caps.hasVideoFrame;
  if (offlineVideo && (!withAudio || caps.hasAudioEncoder)) return 'webcodecs';
  if (caps.canRecord) return 'recorder';
  // Video-only offline export beats nothing.
  if (offlineVideo) return 'webcodecs';
  return 'none';
}

export interface RecorderFormat {
  mimeType: string;
  extension: 'mp4' | 'webm';
}

const RECORDER_FORMATS: RecorderFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
];

/** The best container/codec combination MediaRecorder offers, MP4 first. */
export function pickRecorderFormat(
  isTypeSupported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): RecorderFormat | null {
  for (const f of RECORDER_FORMATS) {
    try {
      if (isTypeSupported(f.mimeType)) return f;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Frame rate the real-time recorder can sustain. Browsers encode live in
 * software; above 720p they keep only about 60% of 30 fps frames, but nearly
 * all of 24 fps ones.
 */
export function recorderFps(width: number, height: number, requested: number): number {
  return Math.min(requested, width * height > 1280 * 720 ? 24 : 30);
}
