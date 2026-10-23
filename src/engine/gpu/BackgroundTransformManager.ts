import type { EffectsConfig } from '@/types/effects';
import { createAudioReactiveEnvelope } from '@/hooks/useAudioReactive';

export interface BackgroundTransformState {
  scale: number;
  offsetX: number;
  offsetY: number;
  angle: number;
  /** True when the slide effect is actively translating — callers should force tiling. */
  slideActive: boolean;
}

export class BackgroundTransformManager {
  private zoomEnvelope = createAudioReactiveEnvelope(0);
  private slideXEnvelope = createAudioReactiveEnvelope(0);
  private slideYEnvelope = createAudioReactiveEnvelope(0);
  private rotateAngleEnvelope = createAudioReactiveEnvelope(0);
  private rotateSpeedEnvelope = createAudioReactiveEnvelope(0);

  private slideAccumX = 0;
  private slideAccumY = 0;
  private rotateAccum = 0;

  /**
   * Reset all accumulators and envelopes to their initial state.
   * Typically called when switching tracks.
   */
  reset() {
    this.slideAccumX = 0;
    this.slideAccumY = 0;
    this.rotateAccum = 0;
    this.zoomEnvelope.reset(1.0);
    this.slideXEnvelope.reset();
    this.slideYEnvelope.reset();
    this.rotateAngleEnvelope.reset();
    this.rotateSpeedEnvelope.reset();
  }

  /**
   * Evaluate background transforms for the current frame.
   * Modifies the given bgState object directly.
   */
  update(
    config: EffectsConfig | undefined,
    dt: number,
    bgState: BackgroundTransformState,
    isPaused: boolean = false,
  ) {
    if (!config || !config.effectInstances) return;

    const zoomInst = config.effectInstances.find(
      (
        e,
      ): e is {
        type: 'zoom';
        config: import('@/types/effects').PostProcessingConfig['zoom'];
        id: string;
      } => e.type === 'zoom',
    );
    const slideInst = config.effectInstances.find(
      (
        e,
      ): e is {
        type: 'slide';
        config: import('@/types/effects').PostProcessingConfig['slide'];
        id: string;
      } => e.type === 'slide',
    );
    const rotateInst = config.effectInstances.find(
      (
        e,
      ): e is {
        type: 'rotate';
        config: import('@/types/effects').PostProcessingConfig['rotate'];
        id: string;
      } => e.type === 'rotate',
    );

    // Zoom
    if (zoomInst && zoomInst.config.enabled) {
      const zc = zoomInst.config;
      const audioEnabled = zc.audioReactive?.enabled ?? false;

      if (!isPaused) {
        // We override the update config dynamically to reflect changes
        this.zoomEnvelope.update(dt, zc.audioReactive);
      }

      bgState.scale *= audioEnabled ? this.zoomEnvelope.current : (zc.scale ?? 1.0);
    } else {
      this.zoomEnvelope.reset(1.0);
    }

    // Slide
    if (slideInst && slideInst.config.enabled) {
      bgState.slideActive = true;
      const sc = slideInst.config;

      if (!isPaused) {
        this.slideXEnvelope.update(dt, sc.audioReactive?.x);
        this.slideYEnvelope.update(dt, sc.audioReactive?.y);
      }

      const speedX = sc.speedX ?? 0;
      const speedY = sc.speedY ?? 0;
      const audioModX = this.slideXEnvelope.current * dt;
      const audioModY = this.slideYEnvelope.current * dt;

      if (!isPaused) {
        this.slideAccumX += speedX * dt + audioModX;
        this.slideAccumY += speedY * dt + audioModY;

        // Wrap accumulators so the background loops seamlessly instead of
        // drifting off-screen.  Using mod-1 keeps the offset in UV space;
        // the shader's fract() (tiling) or the visual period naturally tiles.
        this.slideAccumX = this.slideAccumX - Math.floor(this.slideAccumX);
        this.slideAccumY = this.slideAccumY - Math.floor(this.slideAccumY);
      }

      bgState.offsetX += this.slideAccumX;
      bgState.offsetY += this.slideAccumY;
    } else {
      this.slideAccumX = 0;
      this.slideAccumY = 0;
      this.slideXEnvelope.reset();
      this.slideYEnvelope.reset();
    }

    // Rotate
    if (rotateInst && rotateInst.config.enabled) {
      const rc = rotateInst.config;
      const angleAudioEnabled = rc.audioReactive?.enabled ?? false;

      if (!isPaused) {
        this.rotateAngleEnvelope.update(dt, rc.audioReactive);
        this.rotateSpeedEnvelope.update(dt, rc.speedAudioReactive);
      }

      let angleDeg = angleAudioEnabled ? this.rotateAngleEnvelope.current : (rc.angle ?? 0);
      const speedDeg = rc.speed ?? 0;
      const audioSpeedMod = this.rotateSpeedEnvelope.current * dt;

      if (!isPaused) {
        this.rotateAccum += speedDeg * dt + audioSpeedMod;
      }

      angleDeg += this.rotateAccum;
      bgState.angle += angleDeg * (Math.PI / 180);
    } else {
      this.rotateAccum = 0;
      this.rotateAngleEnvelope.reset();
      this.rotateSpeedEnvelope.reset();
    }
  }
}
