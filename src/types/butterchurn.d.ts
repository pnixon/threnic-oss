declare module 'butterchurn' {
  interface ButterchurnVisualizer {
    connectAudio(node: AudioNode): void;
    disconnectAudio(node: AudioNode): void;
    loadPreset(preset: unknown, blendTime: number): void;
    setRendererSize(
      width: number,
      height: number,
      options?: { pixelRatio?: number; textureRatio?: number },
    ): void;
    render(opts?: {
      audioLevels?: {
        timeByteArray: Uint8Array;
        timeByteArrayL: Uint8Array;
        timeByteArrayR: Uint8Array;
      };
      elapsedTime?: number;
    }): void;
  }

  interface ButterchurnStatic {
    createVisualizer(
      audioContext: AudioContext | OfflineAudioContext,
      canvas: HTMLCanvasElement | OffscreenCanvas,
      options: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): ButterchurnVisualizer;
  }

  const butterchurn: ButterchurnStatic;
  export default butterchurn;
}

declare module 'butterchurn-presets' {
  interface ButterchurnPresetsStatic {
    getPresets(): Record<string, unknown>;
  }

  const butterchurnPresets: ButterchurnPresetsStatic;
  export default butterchurnPresets;
}
