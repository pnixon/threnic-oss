import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamableExportController } from '@/engine/export/StreamableExportController';
import * as THREE from 'three';

// Mock browser APIs
if (typeof window !== 'undefined') {
  (global as any).VideoEncoder = class {
    static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    configure = vi.fn().mockResolvedValue(undefined);
    encode = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    state = 'configured';
    encodeQueueSize = 0;
  } as any;

  (global as any).AudioEncoder = class {
    static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    configure = vi.fn().mockResolvedValue(undefined);
    encode = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    state = 'configured';
  } as any;

  (global as any).VideoFrame = class {
    constructor(source: any, init: any) {
      this.timestamp = init.timestamp;
      this.duration = init.duration;
    }
    timestamp = 0;
    duration = 0;
    close = vi.fn();
  } as any;

  (global as any).AudioData = class {
    constructor() {}
    close = vi.fn();
  } as any;
}

vi.mock('mediabunny', () => {
  class MockOutput {
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockResolvedValue(undefined);
  }
  class MockStreamTarget {}
  return {
    StreamTarget: MockStreamTarget,
    Output: MockOutput,
    EncodedVideoPacketSource: vi.fn(),
    EncodedAudioPacketSource: vi.fn(),
    Mp4OutputFormat: vi.fn(),
    EncodedPacket: {
      fromEncodedChunk: vi.fn().mockReturnValue({}),
    },
  };
});

describe('StreamableExportController', () => {
  let mockRenderer: any;
  let mockScene: any;
  let mockCamera: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRenderer = {
      render: vi.fn(),
      domElement: document.createElement('canvas'),
    };
    mockScene = new THREE.Scene();
    mockCamera = new THREE.PerspectiveCamera();

    (window as any).showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  it('initializes with correct rounded dimensions', () => {
    let controller = new StreamableExportController({ width: 1921, height: 1079 });
    expect(controller.width).toBe(1922);
    expect(controller.height).toBe(1080);
  });

  it('starts export and properly frames 60FPS captures', async () => {
    const controller = new StreamableExportController({ width: 1920, height: 1080, fps: 60 });

    // Auto-acquires the mock file handle via window.showSaveFilePicker
    const started = await controller.start(false);
    expect(started).toBe(true);
    expect(controller.isRecording).toBe(true);

    // We mock VideoEncoder right above so we can inspect the one the controller made
    const videoEncoderMock = (controller as any).videoEncoder;
    expect(videoEncoderMock).not.toBeNull();
    videoEncoderMock.encodeQueueSize = 0; // Mock empty queue

    // Capture 3 frames
    const f0 = new (global as any).VideoFrame(null, { timestamp: 0, duration: 16666.6666 });
    const f1 = new (global as any).VideoFrame(null, {
      timestamp: 16666.6666,
      duration: 16666.6666,
    });
    const f2 = new (global as any).VideoFrame(null, {
      timestamp: 33333.3333,
      duration: 16666.6666,
    });

    await controller.encodeVideoFrame(f0);
    await controller.encodeVideoFrame(f1);
    await controller.encodeVideoFrame(f2);

    expect(videoEncoderMock.encode).toHaveBeenCalledTimes(3);

    const encodeCalls = videoEncoderMock.encode.mock.calls;

    const frame0 = encodeCalls[0][0]; // VideoFrame instance
    expect(frame0.timestamp).toBe(0);
    expect(frame0.duration).toBeCloseTo(16666.6666, 0); // 1_000_000 / 60

    const frame1 = encodeCalls[1][0];
    expect(frame1.timestamp).toBeCloseTo(16666.6666, 0);

    const frame2 = encodeCalls[2][0];
    expect(frame2.timestamp).toBeCloseTo(33333.3333, 0);

    // Frame 0 needs keyframe since 0 % 120 == 0
    expect(encodeCalls[0][1]).toEqual({ keyFrame: true });
    // Frame 1 does not need keyframe
    expect(encodeCalls[1][1]).toEqual({ keyFrame: false });
  });

  it('flushes and closes correctly on stop', async () => {
    const controller = new StreamableExportController({ width: 1920, height: 1080, fps: 60 });

    await controller.start(false);
    const videoEncoderMock = (controller as any).videoEncoder;

    await controller.stop();

    expect(videoEncoderMock.flush).toHaveBeenCalled();
    expect(videoEncoderMock.close).toHaveBeenCalled();
    expect(controller.isRecording).toBe(false);
  });
});
