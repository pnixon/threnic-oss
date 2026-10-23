/**
 * Fetch Scene — Boy & Dog Fetch (top-down).
 *
 * A cozy top-down grass field. A boy stands anchored on the left; a dog is an
 * autonomous agent driven by a small state machine
 * (idle → chase → carry → return → idle). On a beat OR a lyric line start the
 * boy throws a stick that arcs toward a random point on the field; the dog
 * dashes to it, picks it up, carries it back, and drops into idle.
 *
 * Audio mapping (per the shared convention):
 *  - beat / lyric line start → boy throws a stick (chase begins)
 *  - amplitude → dog run speed + tail-wag rate
 *  - treb (> 0.8) → drifting "butterflies / leaves" particles
 *  - mid → warm sun-glow vignette
 *  - time / duration → wide-shot / gap camera logic (reused from rpgCombat)
 *
 * Camera: gently follows the dog (lerp). Wide shot when idle between throws,
 * in lyric gaps (>1.5s), or after the final line — mirroring rpgCombat.
 *
 * Backdrop: only drawn when the user supplies a custom `background` image.
 * With no background the scene stays transparent so Threnic's real background
 * shows through beneath the field, via the alpha-preserving compositor.
 */

import type { GameScene, AudioReactiveData, LyricLineTiming } from '../types';
import { audioStore } from '@/engine/stores/audioStore';

// ─── Sprite loading ──────────────────────────────────────────────────────────

// The boy/dog reuse the bundled rpgCombat placeholder art until proper fetch
// sprites exist. The background has NO default — absence = transparent overlay.
const DEFAULT_LEFT_URL = '/assets/game-scenes/hero.png';
const DEFAULT_RIGHT_URL = '/assets/game-scenes/hydra.png';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── Particle system (drifting butterflies / leaves) ───────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Phase for the sinusoidal horizontal drift. */
  phase: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

/** Dog behaviour states. */
type DogState = 'idle' | 'chase' | 'carry' | 'return';

// ─── Scene ───────────────────────────────────────────────────────────────────

export class FetchScene implements GameScene {
  private width = 0;
  private height = 0;

  // Sprites
  private boyImg: HTMLImageElement | null = null;
  private dogImg: HTMLImageElement | null = null;
  private bgImg: HTMLImageElement | null = null;
  private imagesLoaded = false;
  /** In-flight sprite load, awaited by exports so no blank frames are encoded. */
  private _spritesReady: Promise<void> | null = null;

  // Asset URLs. The background has NO default — an empty URL means "no backdrop".
  private _leftUrl = DEFAULT_LEFT_URL;
  private _rightUrl = DEFAULT_RIGHT_URL;
  private _bgUrl = '';

  // Boy anchor (in scene space)
  private boyX = 0;
  private boyY = 0;

  // Dog agent
  private dogX = 0;
  private dogY = 0;
  private dogState: DogState = 'idle';
  /** Facing direction for the dog sprite (1 = right, -1 = left). */
  private dogFacing = 1;
  /** Tail-wag phase, advanced each frame by a rate ∝ amplitude + wagIntensity. */
  private tailWagPhase = 0;

  // Stick projectile
  private stickActive = false;
  private stickX = 0;
  private stickY = 0;
  /** Throw origin + target, for arcing the stick over its flight. */
  private stickFromX = 0;
  private stickFromY = 0;
  private stickToX = 0;
  private stickToY = 0;
  /** 0→1 progress of the stick's flight arc. */
  private stickT = 0;
  /** Where the stick landed / is resting, so the dog knows where to run. */
  private stickRestX = 0;
  private stickRestY = 0;
  private stickAngle = 0;

  // Camera state
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  private targetCameraX = 0;
  private targetCameraY = 0;
  private targetCameraZoom = 1;

  // Beat detection
  private lastBeat = false;

  // Lyrics-driven camera / throw sync
  private _lyrics: LyricLineTiming[] = [];
  private _currentLineIndex = -1;
  /** Last line index we fired a throw on (so each line start throws once). */
  private _lastThrowLineIndex = -1;

  // Effects
  private glowAlpha = 0;
  private particles: Particle[] = [];

  // Params (user-configurable)
  private _throwBand: 'bass' | 'mid' | 'treb' = 'bass';
  private _dogSpeed = 1;
  private _wagIntensity = 0.5;

  // Throw trigger config
  private _throwThreshold = 0.7;
  private _throwCooldown = 1.2; // seconds between throws
  /**
   * Time of the last throw on whichever clock is active (wall clock live, song
   * time offline). -Infinity so the first throw can fire immediately.
   */
  private _lastThrowTime = -Infinity;

  /** True during offline export: no live audio store, no usable wall clock. */
  private _offline = false;
  /** Most recent value of the active clock, so reset() can stamp it. */
  private _clockNow = 0;

  // ── Resolution independence ────────────────────────────────────────────────
  private static readonly DESIGN_WIDTH = 1920;
  private static readonly DESIGN_HEIGHT = 1080;
  /** Uniform art scale factor derived from the current canvas size. */
  private _scale = 1;

  /** Scale an authored pixel value to the current resolution. */
  private s(v: number): number {
    return v * this._scale;
  }

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this._scale = this.computeScale(width, height);
  }

  private computeScale(width: number, height: number): number {
    if (width <= 0 || height <= 0) return 1;
    return Math.min(width / FetchScene.DESIGN_WIDTH, height / FetchScene.DESIGN_HEIGHT);
  }

  init(width: number, height: number): void {
    this.applyLayout(width, height);

    // Dog starts beside the boy, idle.
    this.dogX = this.boyX + this.s(120);
    this.dogY = this.boyY;
    this.dogState = 'idle';

    // Initial camera: wide shot centered on the field.
    this.cameraX = this.width / 2;
    this.cameraY = this.height / 2;
    this.cameraZoom = 1;
    this.targetCameraX = this.cameraX;
    this.targetCameraY = this.cameraY;
    this.targetCameraZoom = 1;

    this.loadSprites();
  }

  /**
   * Handle a canvas resolution change (e.g. preview 720p → 4K export).
   *
   * The boy anchor is proportional to the canvas and every art constant scales
   * off `_scale`, so the scene is resolution-independent. Transient particles
   * and the in-flight stick live in the old coordinate space, so they are
   * cleared and the camera snaps rather than lerps — a resolution change is a
   * hard cut, not motion.
   */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;

    const prevBoyX = this.boyX || 1;
    const prevBoyY = this.boyY || 1;
    // Preserve the dog's relative offset from the boy across the resize.
    const dogOffX = this.dogX - prevBoyX;
    const dogOffY = this.dogY - prevBoyY;

    this.applyLayout(width, height);

    // Re-anchor the dog proportionally to the new boy anchor.
    const scaleRatioX = this.boyX / prevBoyX;
    const scaleRatioY = this.boyY / prevBoyY;
    this.dogX = this.boyX + dogOffX * scaleRatioX;
    this.dogY = this.boyY + dogOffY * scaleRatioY;

    // Snap the camera; transients belong to the old space.
    this.targetCameraX = this.dogX;
    this.targetCameraY = this.dogY;
    this.cameraX = this.targetCameraX;
    this.cameraY = this.targetCameraY;

    this.particles = [];
    this.stickActive = false;
  }

  /** Recompute canvas size, art scale, and the boy anchor position. */
  private applyLayout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this._scale = this.computeScale(width, height);

    // Boy anchored toward the left of the field; proportional to the canvas so
    // it stays correct at any resolution or aspect ratio.
    this.boyX = width * 0.22;
    this.boyY = height * 0.62;
  }

  setLyrics(lines: LyricLineTiming[]): void {
    this._lyrics = lines;
    this._currentLineIndex = -1;
    this._lastThrowLineIndex = -1;
  }

  /**
   * Switch between live and offline (export) behaviour.
   *
   * Offline changes the throw trigger signal (per-frame `audio` instead of the
   * live audioStore) and the cooldown clock (song time instead of wall clock).
   * The throw stamp is cleared so a mode switch cannot carry a timestamp from
   * the other, unrelated clock.
   */
  setOffline(offline: boolean): void {
    if (offline === this._offline) return;
    this._offline = offline;
    this._lastThrowTime = -Infinity;
    this._clockNow = 0;
  }

  private async loadSprites(): Promise<void> {
    const load = (async () => {
      try {
        const [boy, dog] = await Promise.all([loadImage(this._leftUrl), loadImage(this._rightUrl)]);
        this.boyImg = boy;
        this.dogImg = dog;
        this.imagesLoaded = true;
        // Backdrop is optional: only load it when a custom background was set.
        if (this._bgUrl) {
          try {
            this.bgImg = await loadImage(this._bgUrl);
          } catch {
            this.bgImg = null;
          }
        } else {
          this.bgImg = null;
        }
        console.log('[FetchScene] Sprites loaded');
      } catch (err) {
        console.error('[FetchScene] Failed to load sprites:', err);
      }
    })();
    this._spritesReady = load;
    return load;
  }

  /**
   * Resolves once the current sprite set has finished loading (or failed).
   *
   * Bounded by a timeout because an <img> pointed at a dead blob URL fires
   * neither load nor error and would otherwise hang the export forever.
   */
  whenAssetsReady(timeoutMs = 10_000): Promise<void> {
    if (!this._spritesReady) return Promise.resolve();
    return Promise.race([
      this._spritesReady,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!this.imagesLoaded) {
            console.warn('[FetchScene] Sprite load timed out; drawing without art');
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Set custom asset URLs and reload sprites.
   *
   * The `background` slot is special: an empty / undefined URL clears the
   * backdrop entirely so the scene becomes a transparent overlay. `left`
   * (boy) / `right` (dog) keep their defaults when not supplied.
   */
  setAssetUrls(urls: { left?: string; right?: string; background?: string }): void {
    let changed = false;
    if (urls.left && urls.left !== this._leftUrl) {
      this._leftUrl = urls.left;
      changed = true;
    }
    if (urls.right && urls.right !== this._rightUrl) {
      this._rightUrl = urls.right;
      changed = true;
    }
    // Background can be set OR cleared. Normalize undefined to '' so removing a
    // custom background is a real state change, not a no-op.
    const nextBg = urls.background ?? '';
    if (nextBg !== this._bgUrl) {
      this._bgUrl = nextBg;
      changed = true;
    }
    if (changed) {
      this.imagesLoaded = false;
      this.loadSprites();
    }
  }

  /** Set scene-specific params from config. */
  setParams(params: Record<string, number | string | boolean>): void {
    if (params.throwBand === 'bass' || params.throwBand === 'mid' || params.throwBand === 'treb') {
      this._throwBand = params.throwBand;
    }
    if (typeof params.dogSpeed === 'number' && Number.isFinite(params.dogSpeed)) {
      // Keep positive; clamp to a sane range so the dog never stalls or teleports.
      this._dogSpeed = Math.min(4, Math.max(0.1, params.dogSpeed));
    }
    if (typeof params.wagIntensity === 'number' && Number.isFinite(params.wagIntensity)) {
      this._wagIntensity = Math.min(1, Math.max(0, params.wagIntensity));
    }
  }

  update(audio: AudioReactiveData): void {
    // ── Beat detection ──
    const beatJustHit = audio.beat && !this.lastBeat;
    this.lastBeat = audio.beat;

    // ── Determine active lyric line + gap state (reused from rpgCombat) ──
    let isInLyricGap = false;
    let lineJustStarted = false;

    if (this._lyrics.length > 0) {
      const newLineIndex = this.findLineIndex(audio.time);

      if (newLineIndex < 0) {
        isInLyricGap = true;
      } else {
        const currentLine = this._lyrics[newLineIndex];
        if (audio.time > currentLine.end) {
          const nextLine = this._lyrics[newLineIndex + 1];
          if (!nextLine) {
            // Final lyric has ended — wide shot for the outro.
            isInLyricGap = true;
          } else if (nextLine.start - currentLine.end > 1.5) {
            isInLyricGap = true;
          }
        }
      }

      if (!isInLyricGap && newLineIndex >= 0 && newLineIndex !== this._currentLineIndex) {
        this._currentLineIndex = newLineIndex;
        if (newLineIndex !== this._lastThrowLineIndex) {
          lineJustStarted = true;
          this._lastThrowLineIndex = newLineIndex;
        }
      }
    } else {
      // No lyrics — camera follows the dog when active, wide shot when idle.
      isInLyricGap = this.dogState === 'idle';
    }

    // ── Throw triggers ──
    // Live playback samples audioStore so the throw fires in lockstep with the
    // TriggerLevelWidget's meter, and times cooldowns on the wall clock.
    // Offline export has neither: audioStore is idle and wall-clock runs at the
    // encoder's rate, so it uses the per-frame audio and the song's timeline.
    const trig = this._offline
      ? { bass: audio.bass, mid: audio.mid, high: audio.treb }
      : audioStore.getState();
    const now = this._offline ? audio.time : performance.now() / 1000;
    this._clockNow = now;

    const bandLevel =
      this._throwBand === 'bass' ? trig.bass : this._throwBand === 'mid' ? trig.mid : trig.high;

    const cooldownElapsed = now - this._lastThrowTime >= this._throwCooldown;
    // A throw can be triggered by a strong band transient OR a beat OR a lyric
    // line start — but only when the dog is idle (not already fetching) and the
    // cooldown has elapsed.
    const wantThrow =
      this.dogState === 'idle' &&
      cooldownElapsed &&
      (bandLevel > this._throwThreshold || beatJustHit || lineJustStarted);

    if (wantThrow) {
      this.throwStick();
      this._lastThrowTime = now;
    }

    // ── Advance the stick flight arc ──
    if (this.stickActive) {
      // Flight speed scaled slightly by amplitude for a livelier throw.
      this.stickT += 0.04 + audio.amplitude * 0.02;
      if (this.stickT >= 1) {
        this.stickT = 1;
        this.stickActive = false;
        this.stickRestX = this.stickToX;
        this.stickRestY = this.stickToY;
      }
      // Parabolic arc: straight-line interpolation minus a lofting term.
      const t = this.stickT;
      this.stickX = this.stickFromX + (this.stickToX - this.stickFromX) * t;
      this.stickY =
        this.stickFromY +
        (this.stickToY - this.stickFromY) * t -
        Math.sin(t * Math.PI) * this.s(120);
      this.stickAngle += 0.3;
    }

    // ── Dog state machine ──
    // Run speed scales with amplitude and the dogSpeed param.
    const baseSpeed = this.s(6) * this._dogSpeed;
    const runSpeed = baseSpeed * (0.6 + audio.amplitude * 0.8);

    if (this.dogState === 'chase') {
      // Run to where the stick will rest (its target).
      const tx = this.stickActive ? this.stickToX : this.stickRestX;
      const ty = this.stickActive ? this.stickToY : this.stickRestY;
      const reached = this.moveDogToward(tx, ty, runSpeed);
      // Only pick up once the stick has actually landed.
      if (reached && !this.stickActive) {
        this.dogState = 'carry';
      }
    } else if (this.dogState === 'carry') {
      // Brief pause "picking up", then carry back — reuse the return path.
      this.dogState = 'return';
    } else if (this.dogState === 'return') {
      const reached = this.moveDogToward(this.boyX + this.s(120), this.boyY, runSpeed);
      if (reached) {
        this.dogState = 'idle';
      }
    }

    // ── Tail-wag: rate ∝ amplitude and wagIntensity (faster when excited) ──
    const wagRate = 0.15 + audio.amplitude * 0.9 * (0.3 + this._wagIntensity);
    this.tailWagPhase += wagRate;

    // ── Camera: follow the dog when fetching, wide shot when idle / in gaps ──
    if (isInLyricGap || this.dogState === 'idle') {
      this.targetCameraX = this.width / 2;
      this.targetCameraY = this.height / 2;
      this.targetCameraZoom = 1.0 + audio.amplitude * 0.06;
    } else {
      // Gently follow the dog with a modest zoom.
      this.targetCameraX = this.dogX;
      this.targetCameraY = this.dogY;
      this.targetCameraZoom = 1.25 + audio.amplitude * 0.15;
    }

    const lerpSpeed = 0.08;
    this.cameraX += (this.targetCameraX - this.cameraX) * lerpSpeed;
    this.cameraY += (this.targetCameraY - this.cameraY) * lerpSpeed;
    this.cameraZoom += (this.targetCameraZoom - this.cameraZoom) * lerpSpeed;

    // ── Sun glow driven by mid ──
    this.glowAlpha = audio.mid * 0.6;

    // ── Treble → drifting butterflies / leaves ──
    if (audio.treb > 0.8) {
      const count = Math.floor((audio.treb - 0.8) * 10);
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: (Math.random() - 0.5) * this.s(1.5),
          vy: this.s(-Math.random() * 1.2 - 0.4),
          phase: Math.random() * Math.PI * 2,
          life: 60 + Math.random() * 40,
          maxLife: 100,
          color: this.randomFlutterColor(),
          size: this.s(4 + Math.random() * 5),
        });
      }
    }

    // ── Update particles (sinusoidal horizontal drift, slow rise) ──
    this.particles = this.particles.filter((p) => {
      p.phase += 0.12;
      p.x += p.vx + Math.sin(p.phase) * this.s(0.8);
      p.y += p.vy;
      p.life--;
      return p.life > 0;
    });
  }

  render(audio: AudioReactiveData, ctx: CanvasRenderingContext2D): void {
    // Transparent-first: with no backdrop, clear each frame so the previous
    // frame doesn't ghost and empty regions reveal the app background.
    const hasBackdrop = !!(this.bgImg && this.imagesLoaded);
    if (!hasBackdrop) {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    ctx.save();

    // ── Camera transform ──
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.cameraZoom, this.cameraZoom);
    ctx.translate(-this.cameraX, -this.cameraY);

    // ── Background: only when a custom backdrop image is present ──
    this.drawBackground(ctx);

    // ── Boy ──
    this.drawBoy(ctx);

    // ── Stick (drawn when flying or resting on the field) ──
    this.drawStick(ctx);

    // ── Dog ──
    this.drawDog(ctx);

    // ── Particles ──
    this.drawParticles(ctx);

    ctx.restore();

    // ── Screen-space overlays (not affected by camera) ──

    // Warm sun-glow vignette (mid-driven)
    if (this.glowAlpha > 0.01) {
      this.drawSunGlow(ctx);
    }
  }

  // ─── Private methods ───────────────────────────────────────────────────────

  /** Boy throws a stick toward a random point on the field; dog begins chase. */
  private throwStick(): void {
    this.stickActive = true;
    this.stickT = 0;
    this.stickFromX = this.boyX;
    this.stickFromY = this.boyY - this.s(40);
    // Land somewhere across the field, biased to the right of the boy.
    this.stickToX = this.width * (0.45 + Math.random() * 0.45);
    this.stickToY = this.height * (0.35 + Math.random() * 0.45);
    this.stickX = this.stickFromX;
    this.stickY = this.stickFromY;
    this.stickRestX = this.stickToX;
    this.stickRestY = this.stickToY;
    this.dogState = 'chase';
  }

  /**
   * Move the dog toward a target at the given speed. Sets facing and returns
   * true once the dog is within one step of the target.
   */
  private moveDogToward(tx: number, ty: number, speed: number): boolean {
    const dx = tx - this.dogX;
    const dy = ty - this.dogY;
    const dist = Math.hypot(dx, dy);
    if (dist <= speed || dist < 0.001) {
      this.dogX = tx;
      this.dogY = ty;
      return true;
    }
    this.dogFacing = dx >= 0 ? 1 : -1;
    this.dogX += (dx / dist) * speed;
    this.dogY += (dy / dist) * speed;
    return false;
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    if (!(this.bgImg && this.imagesLoaded)) return;
    const pad = this.s(400);
    const bgW = this.width + pad * 2;
    const bgH = this.height + pad * 2;
    ctx.drawImage(this.bgImg, -pad, -pad, bgW, bgH);
  }

  private drawBoy(ctx: CanvasRenderingContext2D): void {
    const x = this.boyX;
    const y = this.boyY;

    if (this.boyImg && this.imagesLoaded) {
      const spriteH = this.s(160);
      const spriteW = (this.boyImg.width / this.boyImg.height) * spriteH;
      ctx.drawImage(this.boyImg, x - spriteW / 2, y - spriteH * 0.7, spriteW, spriteH);
    } else {
      // Fallback placeholder: a small figure.
      ctx.fillStyle = '#E8B04B';
      ctx.fillRect(x - this.s(16), y - this.s(60), this.s(32), this.s(70));
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `${Math.round(this.s(10))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('BOY', x, y + this.s(28));
    }
  }

  private drawDog(ctx: CanvasRenderingContext2D): void {
    const x = this.dogX;
    const y = this.dogY;

    ctx.save();
    ctx.translate(x, y);
    if (this.dogFacing < 0) ctx.scale(-1, 1);

    if (this.dogImg && this.imagesLoaded) {
      const spriteH = this.s(110);
      const spriteW = (this.dogImg.width / this.dogImg.height) * spriteH;
      ctx.drawImage(this.dogImg, -spriteW / 2, -spriteH * 0.6, spriteW, spriteH);
    } else {
      // Fallback placeholder: a small brown body + wagging tail.
      ctx.fillStyle = '#8B5A2B';
      ctx.fillRect(-this.s(24), -this.s(30), this.s(48), this.s(28));
      // Head
      ctx.fillRect(this.s(18), -this.s(40), this.s(18), this.s(18));
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `${Math.round(this.s(9))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('DOG', 0, this.s(14));
    }

    // Wagging tail — angle oscillates with the tail-wag phase.
    const wagAngle = Math.sin(this.tailWagPhase) * 0.6;
    ctx.save();
    ctx.translate(-this.s(24), -this.s(20));
    ctx.rotate(wagAngle);
    ctx.strokeStyle = '#7A4A22';
    ctx.lineWidth = Math.max(1, this.s(4));
    ctx.beginPath();
    ctx.arc(0, 0, this.s(14), Math.PI * 0.6, Math.PI * 1.1);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  private drawStick(ctx: CanvasRenderingContext2D): void {
    // Draw while flying or once resting on the field (until the dog picks it up).
    const resting = !this.stickActive && this.dogState === 'chase';
    if (!this.stickActive && !resting) return;

    const x = this.stickActive ? this.stickX : this.stickRestX;
    const y = this.stickActive ? this.stickY : this.stickRestY;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.stickAngle);
    ctx.fillStyle = '#A9743B';
    ctx.fillRect(-this.s(14), -this.s(3), this.s(28), this.s(6));
    ctx.restore();
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const alpha = Math.min(1, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      // Simple diamond "wing" shape.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(p.phase) * 0.5);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  private drawSunGlow(ctx: CanvasRenderingContext2D): void {
    const grad = ctx.createRadialGradient(
      this.width * 0.5,
      this.height * 0.3,
      this.width * 0.1,
      this.width * 0.5,
      this.height * 0.3,
      this.width * 0.75,
    );
    grad.addColorStop(0, `rgba(255, 224, 150, ${this.glowAlpha * 0.35})`);
    grad.addColorStop(0.6, `rgba(255, 210, 120, ${this.glowAlpha * 0.12})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private randomFlutterColor(): string {
    const colors = ['#FFD24D', '#FF9E4D', '#9BE36A', '#F7C6E0', '#B7E4FF', '#FFFFFF'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Find the active lyric line at a given time.
   * Returns the index of the line whose start <= time < end, or -1 if between.
   */
  private findLineIndex(time: number): number {
    const lines = this._lyrics;
    if (lines.length === 0) return -1;

    for (let i = 0; i < lines.length; i++) {
      if (time >= lines[i].start && time < lines[i].end) {
        return i;
      }
      if (i < lines.length - 1 && time >= lines[i].start && time < lines[i + 1].start) {
        return i;
      }
    }
    const last = lines[lines.length - 1];
    if (time >= last.start) return lines.length - 1;

    return -1;
  }

  reset(): void {
    this.dogX = this.boyX + this.s(120);
    this.dogY = this.boyY;
    this.dogState = 'idle';
    this.dogFacing = 1;
    this.tailWagPhase = 0;
    this.stickActive = false;
    this.stickT = 0;
    this.particles = [];
    this.glowAlpha = 0;
    this._currentLineIndex = -1;
    this._lastThrowLineIndex = -1;
    this.cameraX = this.width / 2;
    this.cameraY = this.height / 2;
    this.cameraZoom = 1;
    this.targetCameraX = this.cameraX;
    this.targetCameraY = this.cameraY;
    this.targetCameraZoom = 1;
    // Stamp the throw cooldown on the ACTIVE clock so a live wall-clock reading
    // is never compared against song time (or vice-versa) after a seek.
    this._lastThrowTime = this._offline ? this._clockNow : performance.now() / 1000;
  }

  destroy(): void {
    this.boyImg = null;
    this.dogImg = null;
    this.bgImg = null;
    this.particles = [];
  }
}

export default FetchScene;
