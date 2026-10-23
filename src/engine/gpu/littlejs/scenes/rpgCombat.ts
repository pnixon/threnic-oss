/**
 * RPG Combat Scene — Sprite-based pixel art battle with camera system.
 *
 * Left fighter vs Right fighter with audio-reactive camera:
 * - Beat → camera switches focus between the two fighters
 * - Bass → screen shake + impact flash
 * - Mid → highlight/glow on focused character
 * - Treble → spell particles / projectiles
 * - Amplitude → overall zoom intensity + energy aura
 *
 * Camera zooms in on each character when focus switches,
 * simulating dramatic cuts on lyric line starts.
 *
 * Backdrop: the scene only draws a backdrop when the user has supplied a custom
 * background image. With no background (removed / never uploaded) it stays
 * transparent, so Threnic's real background shows through beneath the fighters.
 */

import type { GameScene, AudioReactiveData, LyricLineTiming } from '../types';
import { audioStore } from '@/engine/stores/audioStore';

// ─── Sprite loading ──────────────────────────────────────────────────────────

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

// ─── Particle system ─────────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  type: 'spark' | 'slash' | 'magic' | 'fire';
}

/** Floating combat damage number ("-84") that rises and fades above a target. */
interface DamageNumber {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  /** Integer damage amount to display. */
  value: number;
  /** Crit hits render larger, in gold, with a trailing "!". */
  crit: boolean;
}

/** Sweeping crescent slash drawn across a target when an attack lands. */
interface SlashArc {
  /** Pivot of the arc (the attacker's reach, near the target). */
  x: number;
  y: number;
  life: number;
  maxLife: number;
  /** Rotation of the whole arc in radians. */
  angle: number;
  /** Sweep direction: 1 = clockwise, -1 = counter-clockwise. */
  dir: 1 | -1;
  /** Outer radius of the crescent in scene units. */
  radius: number;
  color: string;
}

/** Which fighter: the one anchored left, or the one anchored right. */
type Side = 'left' | 'right';

interface AttackTriggerParam {
  band?: 'bass' | 'mid' | 'treb';
  threshold?: number;
  cooldown?: number;
}

// ─── Scene ───────────────────────────────────────────────────────────────────

export class RpgCombatScene implements GameScene {
  private width = 0;
  private height = 0;

  // Sprites
  private leftImg: HTMLImageElement | null = null;
  private rightImg: HTMLImageElement | null = null;
  private bgImg: HTMLImageElement | null = null;
  private imagesLoaded = false;
  /** In-flight sprite load, awaited by exports so no blank frames are encoded. */
  private _spritesReady: Promise<void> | null = null;

  // Asset URLs (user-customizable, defaults to static files). The background
  // has NO default — an empty URL means "no backdrop" (transparent overlay).
  private _leftUrl = DEFAULT_LEFT_URL;
  private _rightUrl = DEFAULT_RIGHT_URL;
  private _bgUrl = '';

  // Camera state
  private cameraFocus: Side = 'left'; // which character is focused
  private cameraX = 0; // current camera center X (in scene space)
  private cameraY = 0; // current camera center Y
  private cameraZoom = 1; // current zoom level
  private targetCameraX = 0;
  private targetCameraY = 0;
  private targetCameraZoom = 1;
  private focusSwitchCount = 0;

  // Beat detection
  private lastBeat = false;
  private beatCooldown = 0; // frames to wait before next switch
  private timeSinceLastSwitch = 0;

  // Lyrics-driven camera sync
  private _lyrics: LyricLineTiming[] = [];
  private _currentLineIndex = -1; // which lyric line is active (-1 = none)

  // Effects
  private shakeX = 0;
  private shakeY = 0;
  private flashAlpha = 0;
  private glowAlpha = 0;
  private particles: Particle[] = [];

  // Character positions (in scene space, not screen space)
  private leftX = 0;
  private leftY = 0;
  private rightX = 0;
  private rightY = 0;

  // Animation state
  private leftIdleOffset = 0;
  private rightIdleOffset = 0;
  private leftAttackFrame = 0;
  private rightAttackFrame = 0;
  private leftRecoilFrame = 0;
  private rightRecoilFrame = 0;

  // Params from config (user-toggleable)
  private _leftHover = false;
  private _rightHover = false;
  /**
   * Fraction of HP both fighters drift down to by the end of the song
   * (0–0.5). Also the hard minimum HP so a bar never empties. User-configurable
   * via the "End HP" slider; defaults to 5%.
   */
  private _hpFloor = 0.05;

  // Attack trigger config (user-configurable)
  private _leftAttackBand: 'bass' | 'mid' | 'treb' = 'bass';
  private _leftAttackThreshold = 0.7;
  private _leftAttackCooldown = 1.5; // seconds between attacks
  private _rightAttackBand: 'bass' | 'mid' | 'treb' = 'treb';
  private _rightAttackThreshold = 0.7;
  private _rightAttackCooldown = 1.5;

  // Attack cooldown timers, in seconds on whichever clock is active
  // (wall clock live, song time offline — see _offline).
  // Initialized to -Infinity so the first attack can fire immediately on first
  // play; reset() re-stamps them to "now" to force fresh cooldowns after a seek.
  private _leftLastAttackTime = -Infinity;
  private _rightLastAttackTime = -Infinity;

  /** True during offline export: no live audio store, no usable wall clock. */
  private _offline = false;
  /** Most recent value of the active cooldown clock, so reset() can stamp it. */
  private _clockNow = 0;

  // Life bars
  private leftHp = 1.0; // 0–1 normalized
  private rightHp = 1.0;
  private leftHpTarget = 1.0;
  private rightHpTarget = 1.0;
  /**
   * Media-time (audio.time) of the previous HP update, used to derive a
   * per-frame dt so regen and smoothing are RATE-per-second, not per-frame.
   * -1 = uninitialized. Reset on scene reset/seek so a large jump doesn't
   * produce a single huge dt step.
   */
  private _lastHpTime = -1;

  // Floating damage numbers and slash arcs (visual combat feedback)
  private damageNumbers: DamageNumber[] = [];
  private slashes: SlashArc[] = [];
  /** HP 0–1 maps to this many display HP, so 0.08 damage reads as "80". */
  private static readonly HP_DISPLAY_SCALE = 1000;

  // ── Resolution independence ────────────────────────────────────────────────
  // All art constants below are authored against this reference resolution and
  // multiplied by `_scale` at draw time, so the scene looks identical at 720p
  // and 4K instead of shrinking as the canvas grows.
  private static readonly DESIGN_WIDTH = 1920;
  private static readonly DESIGN_HEIGHT = 1080;
  /** Uniform art scale factor derived from the current canvas size. */
  private _scale = 1;

  /**
   * Scale an authored pixel value to the current resolution.
   * Uses the min of both axis ratios so art never overflows on odd aspects.
   */
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
    return Math.min(width / RpgCombatScene.DESIGN_WIDTH, height / RpgCombatScene.DESIGN_HEIGHT);
  }

  init(width: number, height: number): void {
    this.applyLayout(width, height);

    // Initial camera: focused on the left fighter
    this.cameraX = this.leftX;
    this.cameraY = this.leftY;
    this.cameraZoom = 1.6;
    this.targetCameraX = this.leftX;
    this.targetCameraY = this.leftY;
    this.targetCameraZoom = 1.6;

    // Load sprites
    this.loadSprites();
  }

  /**
   * Handle a canvas resolution change (e.g. preview 720p → 4K export).
   *
   * Character anchors are proportional to the canvas, and every art constant is
   * scaled off `_scale`, so the scene is fully resolution-independent. Camera
   * targets are re-derived from the new anchors; the existing lerp smooths the
   * transition, and in-flight particles are dropped because their positions and
   * velocities belong to the old coordinate space.
   */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;

    this.applyLayout(width, height);

    // Re-anchor the camera to the equivalent point in the new space.
    if (this.cameraFocus === 'left') {
      this.targetCameraX = this.leftX;
      this.targetCameraY = this.leftY;
    } else {
      this.targetCameraX = this.rightX;
      this.targetCameraY = this.rightY;
    }
    // Snap rather than lerp — a resolution change is a hard cut, not motion.
    this.cameraX = this.targetCameraX;
    this.cameraY = this.targetCameraY;

    // Transient effects live in the old coordinate space; clear them.
    this.particles = [];
    this.damageNumbers = [];
    this.slashes = [];
    this.shakeX = 0;
    this.shakeY = 0;
  }

  /** Recompute canvas size, art scale, and character anchor positions. */
  private applyLayout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this._scale = this.computeScale(width, height);

    // Character positions are proportional to the canvas, so they stay correct
    // at any resolution or aspect ratio.
    this.leftX = width * 0.25;
    this.leftY = height * 0.55;
    this.rightX = width * 0.72;
    this.rightY = height * 0.5;
  }

  setLyrics(lines: LyricLineTiming[]): void {
    this._lyrics = lines;
    this._currentLineIndex = -1;
  }

  /**
   * Switch between live and offline (export) behaviour.
   *
   * Offline changes two things: the attack trigger signal comes from the audio
   * passed to update() instead of the live audioStore, and cooldowns are timed
   * on song time instead of the wall clock. Both cooldown stamps are cleared so
   * a mode switch cannot leave behind a timestamp taken from the other clock —
   * the two are unrelated quantities, so a stale stamp either fires an attack
   * every frame or suppresses attacks for the rest of the render.
   */
  setOffline(offline: boolean): void {
    if (offline === this._offline) return;
    this._offline = offline;
    this._leftLastAttackTime = -Infinity;
    this._rightLastAttackTime = -Infinity;
    this._clockNow = 0;
    // The HP dt derives from audio.time, but toggling offline swaps how time is
    // sourced; drop the stale stamp so the next update seeds a fresh 1/60 dt
    // instead of a spurious jump.
    this._lastHpTime = -1;
  }

  private async loadSprites(): Promise<void> {
    const load = (async () => {
      try {
        const [left, right] = await Promise.all([
          loadImage(this._leftUrl),
          loadImage(this._rightUrl),
        ]);
        this.leftImg = left;
        this.rightImg = right;
        this.imagesLoaded = true;
        // Backdrop is optional: only load it when a custom background was set.
        // A missing background means "no backdrop" (transparent overlay).
        if (this._bgUrl) {
          try {
            this.bgImg = await loadImage(this._bgUrl);
          } catch {
            this.bgImg = null;
          }
        } else {
          this.bgImg = null;
        }
        console.log('[RpgCombatScene] Sprites loaded');
      } catch (err) {
        console.error('[RpgCombatScene] Failed to load sprites:', err);
      }
    })();
    this._spritesReady = load;
    return load;
  }

  /**
   * Resolves once the current sprite set has finished loading (or failed).
   *
   * Live playback can tolerate a few sprite-less frames, but an export cannot:
   * the encoder would bake blank frames into the start of the video. The export
   * renderer awaits this before the frame loop begins.
   *
   * Bounded by a timeout because an <img> pointed at a dead blob URL (a stale
   * IDB entry, a revoked object URL) fires neither load nor error and would
   * otherwise hang the export forever.
   */
  whenAssetsReady(timeoutMs = 10_000): Promise<void> {
    if (!this._spritesReady) return Promise.resolve();
    return Promise.race([
      this._spritesReady,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!this.imagesLoaded) {
            console.warn('[RpgCombatScene] Sprite load timed out; drawing without art');
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Set custom asset URLs and reload sprites.
   * Called by the renderer when the user uploads (or removes) custom images.
   *
   * The `background` slot is special: an empty / undefined URL clears the
   * backdrop entirely so the scene becomes a transparent overlay on Threnic's
   * own background. `left` / `right` keep their defaults when not supplied
   * (the fighters must always render).
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
    // custom background (empty URL) is a real state change, not a no-op.
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

  /**
   * Set scene-specific params from config (e.g., leftHover, rightHover toggles).
   */
  setParams(params: Record<string, number | string | boolean>): void {
    this._leftHover = !!params.leftHover;
    this._rightHover = !!params.rightHover;
    if (typeof params.hpFloor === 'number' && Number.isFinite(params.hpFloor)) {
      // Clamp to a sane range: never below 0, and cap at 0.5 so the bars still
      // visibly decline over the song rather than barely moving.
      this._hpFloor = Math.min(0.5, Math.max(0, params.hpFloor));
    }

    // Attack trigger config (compound objects from TriggerLevelWidget)
    const leftAttack = (params as Record<string, unknown>).leftAttack as
      | AttackTriggerParam
      | null
      | undefined;
    if (leftAttack && typeof leftAttack === 'object') {
      if (leftAttack.band) this._leftAttackBand = leftAttack.band;
      if (typeof leftAttack.threshold === 'number')
        this._leftAttackThreshold = leftAttack.threshold;
      if (typeof leftAttack.cooldown === 'number') this._leftAttackCooldown = leftAttack.cooldown;
    }
    // Legacy flat params (backward compat)
    if (params.leftAttackBand) {
      this._leftAttackBand = params.leftAttackBand as 'bass' | 'mid' | 'treb';
    }
    if (typeof params.leftAttackThreshold === 'number') {
      this._leftAttackThreshold = params.leftAttackThreshold;
    }
    if (typeof params.leftAttackCooldown === 'number') {
      this._leftAttackCooldown = params.leftAttackCooldown;
    }

    const rightAttack = (params as Record<string, unknown>).rightAttack as
      | AttackTriggerParam
      | null
      | undefined;
    if (rightAttack && typeof rightAttack === 'object') {
      if (rightAttack.band) this._rightAttackBand = rightAttack.band;
      if (typeof rightAttack.threshold === 'number')
        this._rightAttackThreshold = rightAttack.threshold;
      if (typeof rightAttack.cooldown === 'number')
        this._rightAttackCooldown = rightAttack.cooldown;
    }
    // Legacy flat params (backward compat)
    if (params.rightAttackBand) {
      this._rightAttackBand = params.rightAttackBand as 'bass' | 'mid' | 'treb';
    }
    if (typeof params.rightAttackThreshold === 'number') {
      this._rightAttackThreshold = params.rightAttackThreshold;
    }
    if (typeof params.rightAttackCooldown === 'number') {
      this._rightAttackCooldown = params.rightAttackCooldown;
    }
  }

  update(audio: AudioReactiveData): void {
    this.timeSinceLastSwitch++;
    if (this.beatCooldown > 0) this.beatCooldown--;

    // ── Beat detection ──
    const beatJustHit = audio.beat && !this.lastBeat;
    this.lastBeat = audio.beat;
    void beatJustHit;

    // ── Camera switch: lyrics-driven (primary) ──
    let shouldSwitch = false;
    let isInLyricGap = false; // true when between lines or before/after lyrics

    if (this._lyrics.length > 0) {
      // Find active lyric line at current time
      const newLineIndex = this.findLineIndex(audio.time);

      // Detect gaps: before lyrics start, or substantial gaps between lines (>1.5s)
      if (newLineIndex < 0) {
        isInLyricGap = true;
      } else {
        const currentLine = this._lyrics[newLineIndex];
        if (audio.time > currentLine.end) {
          // We're past the end of this line but findLineIndex still returns it.
          const nextLine = this._lyrics[newLineIndex + 1];
          if (!nextLine) {
            // No next line: the song's final lyric has ended. Zoom out to the
            // wide shot so both characters are visible for the outro.
            isInLyricGap = true;
          } else if (nextLine.start - currentLine.end > 1.5) {
            // Real gap (instrumental break, intro, etc.) between lines.
            isInLyricGap = true;
          }
        }
      }

      if (!isInLyricGap && newLineIndex !== this._currentLineIndex && newLineIndex >= 0) {
        this._currentLineIndex = newLineIndex;
        // Camera focus is determined by line index parity:
        // even lines → left fighter, odd lines → right fighter
        const newFocus: Side = newLineIndex % 2 === 0 ? 'left' : 'right';
        if (newFocus !== this.cameraFocus) {
          shouldSwitch = true;
        }
      }
    } else {
      // No lyrics at all — always wide shot
      isInLyricGap = true;
    }
    // No beat-driven camera switching — attacks should NOT move the camera.
    // Camera only moves on lyric line start boundaries.

    if (shouldSwitch && this.timeSinceLastSwitch > 20) {
      this.switchFocus();
      this.timeSinceLastSwitch = 0;
    }

    // ── Camera target based on focus (or wide shot in gaps) ──
    if (isInLyricGap) {
      // Wide shot: center between both characters, zoom out to show both
      this.targetCameraX = (this.leftX + this.rightX) / 2;
      this.targetCameraY = (this.leftY + this.rightY) / 2;
      this.targetCameraZoom = 1.0 + audio.amplitude * 0.1;
    } else if (this.cameraFocus === 'left') {
      this.targetCameraX = this.leftX;
      this.targetCameraY = this.leftY;
      this.targetCameraZoom = 1.6 + audio.amplitude * 0.3;
    } else {
      this.targetCameraX = this.rightX;
      this.targetCameraY = this.rightY;
      this.targetCameraZoom = 1.5 + audio.amplitude * 0.2;
    }

    // Smooth camera interpolation — fast enough to arrive within ~10 frames
    const lerpSpeed = 0.15;
    this.cameraX += (this.targetCameraX - this.cameraX) * lerpSpeed;
    this.cameraY += (this.targetCameraY - this.cameraY) * lerpSpeed;
    this.cameraZoom += (this.targetCameraZoom - this.cameraZoom) * lerpSpeed;

    // ── Screen shake from bass (only on strong hits) ──
    if (audio.bass > 0.85) {
      const intensity = this.s((audio.bass - 0.85) * 20);
      this.shakeX = (Math.random() - 0.5) * intensity;
      this.shakeY = (Math.random() - 0.5) * intensity;
    } else {
      this.shakeX *= 0.6;
      this.shakeY *= 0.6;
    }

    // ── Attack triggers ──
    // Live playback samples audioStore so the scene fires in lockstep with the
    // TriggerLevelWidget's meter, and times cooldowns on the wall clock.
    // Offline export has neither: audioStore is idle (nothing is playing) and
    // wall-clock runs at the encoder's rate, so it uses the per-frame audio it
    // was handed and the song's own timeline instead.
    const trig = this._offline
      ? { bass: audio.bass, mid: audio.mid, high: audio.treb }
      : audioStore.getState();
    const now = this._offline ? audio.time : performance.now() / 1000;
    this._clockNow = now;

    // Mutual exclusion: minimum separation between ANY two attacks (prevents simultaneous firing)
    const ATTACK_SEPARATION = 0.3; // seconds — one must wait if the other just fired
    const lastGlobalAttack = Math.max(this._leftLastAttackTime, this._rightLastAttackTime);

    const leftLiveLevel =
      this._leftAttackBand === 'bass'
        ? trig.bass
        : this._leftAttackBand === 'mid'
          ? trig.mid
          : trig.high;

    // Left attack: triggers when its assigned band exceeds threshold + own cooldown + global separation
    const leftSignal = leftLiveLevel;
    const leftReady =
      leftSignal > this._leftAttackThreshold &&
      this.leftAttackFrame === 0 &&
      now - this._leftLastAttackTime >= this._leftAttackCooldown &&
      now - lastGlobalAttack >= ATTACK_SEPARATION;

    const rightLiveLevel =
      this._rightAttackBand === 'bass'
        ? trig.bass
        : this._rightAttackBand === 'mid'
          ? trig.mid
          : trig.high;

    // Right attack: triggers when its assigned band exceeds threshold + own cooldown + global separation
    const rightSignal = rightLiveLevel;
    const rightReady =
      rightSignal > this._rightAttackThreshold &&
      this.rightAttackFrame === 0 &&
      now - this._rightLastAttackTime >= this._rightAttackCooldown &&
      now - lastGlobalAttack >= ATTACK_SEPARATION;

    // If both are ready on the same frame, pick the one with the stronger signal
    // (the other will fire on the next frame once separation passes)
    if (leftReady && rightReady) {
      if (leftSignal >= rightSignal) {
        this._fireLeftAttack(now);
      } else {
        this._fireRightAttack(now);
      }
    } else if (leftReady) {
      this._fireLeftAttack(now);
    } else if (rightReady) {
      this._fireRightAttack(now);
    }
    this.flashAlpha *= 0.88;

    // ── Glow on focused character (mid-driven) ──
    this.glowAlpha = audio.mid * 0.6;

    // ── Treble → particles (only on strong treble peaks) ──
    if (audio.treb > 0.8) {
      const count = Math.floor((audio.treb - 0.8) * 10);
      for (let i = 0; i < count; i++) {
        const focusX = this.cameraFocus === 'left' ? this.leftX : this.rightX;
        const focusY = this.cameraFocus === 'left' ? this.leftY : this.rightY;
        this.particles.push({
          x: focusX + (Math.random() - 0.5) * this.s(100),
          y: focusY + (Math.random() - 0.5) * this.s(80),
          vx: (Math.random() - 0.5) * this.s(4),
          vy: this.s(-Math.random() * 3 - 1),
          life: 25 + Math.random() * 20,
          maxLife: 45,
          color: this.randomParticleColor(),
          size: this.s(2 + Math.random() * 4),
          type: Math.random() > 0.5 ? 'magic' : 'spark',
        });
      }
    }

    // ── Update particles ──
    this.particles = this.particles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += this.s(0.08);
      p.life--;
      return p.life > 0;
    });

    // ── Update floating damage numbers (rise, drift, decelerate) ──
    this.damageNumbers = this.damageNumbers.filter((d) => {
      d.x += d.vx;
      d.y += d.vy;
      d.vy += this.s(0.055); // gravity — the number arcs up then settles
      d.life--;
      return d.life > 0;
    });

    // ── Update slash arcs (they only age; the sweep is derived from life) ──
    this.slashes = this.slashes.filter((s) => {
      s.life--;
      return s.life > 0;
    });

    // ── Character idle animations (only when hover enabled) ──
    this.leftIdleOffset = this._leftHover ? Math.sin(audio.time * 2.5) * this.s(3) : 0;
    this.rightIdleOffset = this._rightHover ? Math.sin(audio.time * 1.8 + 1) * this.s(4) : 0;

    // ── Attack animation decay ──
    if (this.leftAttackFrame > 0) this.leftAttackFrame--;
    if (this.rightAttackFrame > 0) this.rightAttackFrame--;
    if (this.leftRecoilFrame > 0) this.leftRecoilFrame--;
    if (this.rightRecoilFrame > 0) this.rightRecoilFrame--;

    // ── Life bars: damage when being attacked, slow regen ──
    // Damage lands one frame after the swing starts, so the number pops with the hit.
    // A hard bass transient at the moment of impact reads as a critical hit.

    // Song-progress HP floor: both bars drift from full at the start down to
    // the user-configured end HP (default ~5%) by the end of the song, so the
    // battle visibly "wears the fighters down" over the track. Combat
    // damage/regen ripples on top of this floor. duration<=0 means the song
    // length is unknown (e.g. no timeStore yet), so we fall back to a static
    // full-HP floor and let combat alone drive the bar.
    const MIN_HP = this._hpFloor;
    const progress = audio.duration > 0 ? Math.min(1, Math.max(0, audio.time / audio.duration)) : 0;
    const floor = 1 - (1 - MIN_HP) * progress; // 1.0 → MIN_HP across the song

    // dt in seconds since the last HP update, derived from the MEDIA clock
    // (audio.time) so it is identical in live preview and export regardless of
    // fps or song length. Clamp to a sane per-frame range: a first frame or a
    // seek yields time deltas that must not produce one giant regen/smoothing
    // step. Falls back to ~60fps when the delta is unusable.
    let dt = this._lastHpTime >= 0 ? audio.time - this._lastHpTime : 1 / 60;
    if (!(dt > 0) || dt > 0.5) dt = 1 / 60;
    this._lastHpTime = audio.time;

    if (this.leftAttackFrame === 11) {
      const crit = audio.bass > 0.9;
      const dmg = 0.08 + audio.bass * 0.05;
      const before = this.rightHpTarget;
      this.rightHpTarget = Math.max(MIN_HP, this.rightHpTarget - dmg);
      this.spawnDamageNumber(this.rightX, this.rightY, before - this.rightHpTarget, crit);
    }
    // When the right fighter attacks, the left fighter takes damage
    if (this.rightAttackFrame === 11) {
      const crit = audio.bass > 0.9;
      const dmg = 0.06 + audio.bass * 0.04;
      const before = this.leftHpTarget;
      this.leftHpTarget = Math.max(MIN_HP, this.leftHpTarget - dmg);
      this.spawnDamageNumber(this.leftX, this.leftY, before - this.leftHpTarget, crit);
    }
    // Regen pulls the bar back UP toward the current song-progress floor rather
    // than toward full, so a lull in combat cannot undo the song-long decay.
    // RATE-based (per second) × dt so the follow speed is independent of fps and
    // song length — a per-frame constant made short songs lag and long songs
    // hug the floor. ~0.12 HP/s of regen matches the old 0.002/frame @ 60fps.
    const REGEN_PER_SEC = 0.12;
    this.leftHpTarget = Math.min(floor, this.leftHpTarget + REGEN_PER_SEC * dt);
    this.rightHpTarget = Math.min(floor, this.rightHpTarget + REGEN_PER_SEC * dt);
    // Never let either fighter's target fall below the visible minimum.
    this.leftHpTarget = Math.max(MIN_HP, this.leftHpTarget);
    this.rightHpTarget = Math.max(MIN_HP, this.rightHpTarget);
    // Smooth HP towards target. Exponential approach with a time constant, so
    // the smoothing tracks the target at the same real-time rate at any fps.
    // 1 - e^(-dt/tau); tau≈0.16s ≈ the old 0.1/frame @ 60fps.
    const smooth = 1 - Math.exp(-dt / 0.16);
    this.leftHp += (this.leftHpTarget - this.leftHp) * smooth;
    this.rightHp += (this.rightHpTarget - this.rightHp) * smooth;
  }

  render(audio: AudioReactiveData, ctx: CanvasRenderingContext2D): void {
    // With no backdrop, nothing overpaints the previous frame, so clear the
    // canvas to transparent first to avoid ghosting and to keep the empty
    // regions truly transparent for the app background to show through.
    const hasBackdrop = !!(this.bgImg && this.imagesLoaded);
    if (!hasBackdrop) {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    ctx.save();

    // Apply screen shake
    ctx.translate(this.shakeX, this.shakeY);

    // ── Apply camera transform ──
    // Camera zooms into the focused character
    const zoom = this.cameraZoom;
    const cx = this.cameraX;
    const cy = this.cameraY;

    // Translate so camera center is at screen center, then scale
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);

    // ── Background: only when a custom backdrop image is present ──
    this.drawBackground(ctx);

    // ── Draw characters ──
    this.drawLeft(ctx);
    this.drawRight(ctx);

    // ── Draw life bars above characters ──
    this.drawLifeBar(
      ctx,
      this.leftX,
      this.leftY - this.s(110) + this.leftIdleOffset,
      this.leftHp,
      '#44CC44',
    );
    this.drawLifeBar(
      ctx,
      this.rightX,
      this.rightY - this.s(130) + this.rightIdleOffset,
      this.rightHp,
      '#44CC44',
    );

    // ── Draw particles (in scene space) ──
    this.drawParticles(ctx);

    // ── Slash arcs sit above characters but below the damage numbers ──
    this.drawSlashes(ctx);

    // ── Damage numbers draw last so they're never occluded ──
    this.drawDamageNumbers(ctx);

    // Restore camera transform before overlays
    ctx.restore();

    // ── Screen-space overlays (not affected by camera) ──

    // Focus glow vignette
    if (this.glowAlpha > 0.01) {
      this.drawFocusVignette(ctx);
    }

    // Impact flash
    if (this.flashAlpha > 0.01) {
      ctx.globalAlpha = this.flashAlpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }

    // ── Scanline overlay (retro CRT feel) ──
    // Spacing and thickness scale with resolution, otherwise at 4K the lines
    // collapse into a 1px moire instead of reading as scanlines.
    // Skipped when there is no backdrop — a full-canvas tint would darken the
    // revealed app background instead of just the scene's own art.
    if (hasBackdrop) {
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = '#000000';
      const scanStep = Math.max(2, Math.round(this.s(3)));
      const scanThickness = Math.max(1, Math.round(this.s(1)));
      for (let y = 0; y < this.height; y += scanStep) {
        ctx.fillRect(0, y, this.width, scanThickness);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ─── Private methods ───────────────────────────────────────────────────────

  private switchFocus(): void {
    this.cameraFocus = this.cameraFocus === 'left' ? 'right' : 'left';
    this.focusSwitchCount++;

    // Spawn dramatic particles on switch
    const fx = this.cameraFocus === 'left' ? this.leftX : this.rightX;
    const fy = this.cameraFocus === 'left' ? this.leftY : this.rightY;
    for (let i = 0; i < 8; i++) {
      this.particles.push({
        x: fx + (Math.random() - 0.5) * this.s(60),
        y: fy + (Math.random() - 0.5) * this.s(60),
        vx: (Math.random() - 0.5) * this.s(6),
        vy: (Math.random() - 0.5) * this.s(6),
        life: 30,
        maxLife: 30,
        color: '#FFCC00',
        size: this.s(3 + Math.random() * 5),
        type: 'slash',
      });
    }
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // Only draw a backdrop when the user supplied a custom background image.
    // With no background the canvas stays transparent here and Threnic's real
    // background shows through beneath the fighters.
    if (!(this.bgImg && this.imagesLoaded)) return;
    // Draw background image covering the full scene (with extra bleed for camera pan)
    const pad = this.s(400); // extra pixels to avoid seeing edges during camera pan/zoom
    const bgW = this.width + pad * 2;
    const bgH = this.height + pad * 2;
    ctx.drawImage(this.bgImg, -pad, -pad, bgW, bgH);
  }

  private drawLeft(ctx: CanvasRenderingContext2D): void {
    const x = this.leftX;
    const y = this.leftY + this.leftIdleOffset;

    // Attack lunge (toward the right fighter = rightward)
    let attackOffset = 0;
    if (this.leftAttackFrame > 0) {
      const progress = this.leftAttackFrame / 12;
      attackOffset = Math.sin(progress * Math.PI) * this.s(30);
    }

    // Recoil (knocked back left when hit)
    let recoilOffset = 0;
    if (this.leftRecoilFrame > 0) {
      const progress = this.leftRecoilFrame / 10;
      recoilOffset = -Math.sin(progress * Math.PI) * this.s(20);
    }

    if (this.leftImg && this.imagesLoaded) {
      const spriteH = this.s(180);
      const spriteW = (this.leftImg.width / this.leftImg.height) * spriteH;

      ctx.save();
      ctx.translate(x + attackOffset + recoilOffset, y);

      // Slight bob on attack
      if (this.leftAttackFrame > 6) {
        ctx.rotate(-0.05);
      }
      // Tilt back on recoil
      if (this.leftRecoilFrame > 5) {
        ctx.rotate(0.08);
      }

      ctx.drawImage(this.leftImg, -spriteW / 2, -spriteH * 0.7, spriteW, spriteH);
      ctx.restore();
    } else {
      // Fallback: simple rectangle placeholder
      ctx.fillStyle = '#4488FF';
      ctx.fillRect(x - this.s(20) + attackOffset, y - this.s(60), this.s(40), this.s(80));
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `${Math.round(this.s(10))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('LEFT', x + attackOffset, y + this.s(30));
    }
  }

  private drawRight(ctx: CanvasRenderingContext2D): void {
    const x = this.rightX;
    const y = this.rightY + this.rightIdleOffset;

    // Attack lunge (toward the left fighter = leftward)
    let attackOffset = 0;
    if (this.rightAttackFrame > 0) {
      const progress = this.rightAttackFrame / 12;
      attackOffset = -Math.sin(progress * Math.PI) * this.s(25);
    }

    // Recoil (knocked back right when hit)
    let recoilOffset = 0;
    if (this.rightRecoilFrame > 0) {
      const progress = this.rightRecoilFrame / 10;
      recoilOffset = Math.sin(progress * Math.PI) * this.s(20);
    }

    if (this.rightImg && this.imagesLoaded) {
      const spriteH = this.s(220);
      const spriteW = (this.rightImg.width / this.rightImg.height) * spriteH;

      ctx.save();
      ctx.translate(x + attackOffset + recoilOffset, y);

      // Slight bob on attack
      if (this.rightAttackFrame > 6) {
        ctx.rotate(0.04);
      }
      // Tilt back on recoil
      if (this.rightRecoilFrame > 5) {
        ctx.rotate(-0.06);
      }

      ctx.drawImage(this.rightImg, -spriteW / 2, -spriteH * 0.6, spriteW, spriteH);
      ctx.restore();
    } else {
      // Fallback placeholder
      ctx.fillStyle = '#44AA44';
      ctx.fillRect(x - this.s(30) + attackOffset, y - this.s(70), this.s(60), this.s(100));
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `${Math.round(this.s(10))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('RIGHT', x + attackOffset, y + this.s(40));
    }
  }

  /**
   * Draw a retro-style life bar above a character.
   */
  private drawLifeBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    hp: number,
    fillColor: string,
  ): void {
    const barWidth = this.s(80);
    const barHeight = this.s(8);
    // Outline thickness scales too, so the bar keeps its chunky pixel-art edge
    // instead of a hairline border at high resolutions.
    const edge = Math.max(1, this.s(1));
    const bx = x - barWidth / 2;
    const by = y;

    // Background (dark)
    ctx.fillStyle = '#111111';
    ctx.fillRect(bx - edge, by - edge, barWidth + edge * 2, barHeight + edge * 2);

    // Damage portion (the "empty" track behind the fill). Kept a DARK maroon,
    // distinct from every fill colour below, so a low-HP fill never blends into
    // it — previously this and the low-HP fill were the same red and the last
    // sliver of life was invisible.
    ctx.fillStyle = '#3A0E0E';
    ctx.fillRect(bx, by, barWidth, barHeight);

    // HP fill (green → yellow → bright red as HP drops). The low-HP red is much
    // brighter than the dark maroon track so even the minimum 5% sliver reads
    // clearly.
    let color = fillColor;
    if (hp < 0.3) color = '#FF5544';
    else if (hp < 0.6) color = '#FFCC33';
    ctx.fillStyle = color;
    // Enforce a minimum visible fill width so the bar never collapses to a
    // hairline even at the song-end 5% floor.
    const minFill = this.s(3);
    const fillW = Math.max(hp > 0 ? minFill : 0, barWidth * Math.max(0, hp));
    ctx.fillRect(bx, by, fillW, barHeight);

    // Border (pixel art style — scaled dark outline)
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = edge;
    ctx.strokeRect(bx - edge, by - edge, barWidth + edge * 2, barHeight + edge * 2);
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      if (p.type === 'slash') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI * 0.25 + Math.random() * 0.2);
        const t = Math.max(1, this.s(2));
        ctx.fillRect(-p.size, -t / 2, p.size * 2, t);
        ctx.restore();
      } else if (p.type === 'magic') {
        // Diamond
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI * 0.25);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }

      ctx.globalAlpha = 1;
    }
  }

  /**
   * Draw sweeping crescent slashes.
   * The arc is drawn as a tapered wedge that sweeps open over its lifetime:
   * it starts as a thin sliver, opens to a wide crescent, then thins out as it
   * fades — which reads as a blade travelling through the target.
   */
  private drawSlashes(ctx: CanvasRenderingContext2D): void {
    for (const s of this.slashes) {
      const t = 1 - s.life / s.maxLife; // 0 → 1 over the swing
      const alpha = Math.sin(Math.PI * Math.min(1, t * 1.15)); // fade in fast, out slow
      if (alpha <= 0.01) continue;

      // Sweep: the arc grows from a sliver to ~120° of travel
      const sweep = Math.PI * 0.66 * Math.min(1, t * 1.4);
      const start = s.angle;
      const end = s.angle + sweep * s.dir;
      // Blade thickness peaks mid-swing
      const thickness = this.s(11) * Math.sin(Math.PI * Math.min(1, t * 1.1)) + this.s(2);
      // radius was already scaled at spawn time
      const r = s.radius * (0.72 + t * 0.34);

      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.globalAlpha = alpha;

      // Outer glow pass, then a bright core — cheap two-pass bloom
      ctx.strokeStyle = s.color;
      ctx.lineCap = 'round';

      ctx.globalAlpha = alpha * 0.35;
      ctx.lineWidth = thickness + this.s(8);
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.min(start, end), Math.max(start, end));
      ctx.stroke();

      ctx.globalAlpha = alpha;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.min(start, end), Math.max(start, end));
      ctx.stroke();

      // White-hot inner edge for the first half of the swing
      if (t < 0.55) {
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = Math.max(1, thickness * 0.35);
        ctx.beginPath();
        ctx.arc(0, 0, r, Math.min(start, end), Math.max(start, end));
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /**
   * Draw floating damage numbers in a chunky retro style:
   * black outline + solid fill, gold and larger on crits.
   */
  private drawDamageNumbers(ctx: CanvasRenderingContext2D): void {
    for (const d of this.damageNumbers) {
      const lifeT = d.life / d.maxLife;
      // Hold full opacity for the first half, then fade out
      const alpha = lifeT > 0.5 ? 1 : lifeT * 2;
      // Pop: overshoot scale on spawn, settle to 1
      const age = 1 - lifeT;
      const pop = age < 0.16 ? 1 + (0.16 - age) * 3.2 : 1;

      const baseSize = this.s(d.crit ? 30 : 22);
      const size = baseSize * pop;
      const label = d.crit ? `${d.value}!` : `${d.value}`;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `bold ${Math.max(8, Math.round(size))}px "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Outline for readability over any background
      ctx.lineWidth = Math.max(this.s(3), size * 0.22);
      ctx.strokeStyle = '#000000';
      ctx.strokeText(label, d.x, d.y);

      ctx.fillStyle = d.crit ? '#FFD230' : '#FF5544';
      ctx.fillText(label, d.x, d.y);

      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  private drawFocusVignette(ctx: CanvasRenderingContext2D): void {
    // Dark vignette around edges with colored tint based on focus
    const grad = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      this.width * 0.2,
      this.width / 2,
      this.height / 2,
      this.width * 0.7,
    );
    const color = this.cameraFocus === 'left' ? '40, 80, 200' : '40, 180, 40';
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.7, `rgba(${color}, ${this.glowAlpha * 0.1})`);
    grad.addColorStop(1, `rgba(0, 0, 0, ${0.3 + this.glowAlpha * 0.2})`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private randomParticleColor(): string {
    const colors = ['#FFCC00', '#FF6600', '#00CCFF', '#FF44CC', '#44FF44', '#FFFFFF'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /** Fire the left fighter's attack — extracted for mutual-exclusion logic. */
  private _fireLeftAttack(now: number): void {
    this.leftAttackFrame = 12;
    this._leftLastAttackTime = now;
    this.flashAlpha = Math.max(this.flashAlpha, 0.25);
    this.spawnDamageParticles(this.rightX, this.rightY);
    this.spawnSlash(this.rightX, this.rightY, 'left');
    this.rightRecoilFrame = 10;
    this.notifyAttack('left', now);
  }

  /** Fire the right fighter's attack — extracted for mutual-exclusion logic. */
  private _fireRightAttack(now: number): void {
    this.rightAttackFrame = 12;
    this._rightLastAttackTime = now;
    this.flashAlpha = Math.max(this.flashAlpha, 0.2);
    this.spawnDamageParticles(this.leftX, this.leftY);
    this.spawnSlash(this.leftX, this.leftY, 'right');
    this.leftRecoilFrame = 10;
    this.notifyAttack('right', now);
  }

  /**
   * Tell the UI an attack fired, so TriggerLevelWidget's cooldown bar tracks the
   * scene 1:1. Suppressed offline: an export would flood the live widget with
   * events on song time while the user watches at wall-clock speed.
   */
  private notifyAttack(id: Side, now: number): void {
    if (this._offline || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('gameSceneAttack', { detail: { id, time: now } }));
  }

  /**
   * Spawn a sweeping crescent slash across a target.
   * The left fighter swings a cyan-white blade; the right rakes with a green
   * claw. The arc angle alternates per hit so repeated attacks don't look
   * identical.
   */
  private spawnSlash(targetX: number, targetY: number, attacker: Side): void {
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    // Left slashes down-right, right rakes down-left — mirrored base angles,
    // with jitter so consecutive swings read as distinct swings.
    const baseAngle = attacker === 'left' ? -Math.PI * 0.25 : Math.PI * 0.75;
    this.slashes.push({
      x: targetX,
      y: targetY - this.s(30),
      life: 14,
      maxLife: 14,
      angle: baseAngle + (Math.random() - 0.5) * 0.6,
      dir,
      radius: this.s(attacker === 'left' ? 78 : 92),
      color: attacker === 'left' ? '#BFF7FF' : '#9BFF6A',
    });
  }

  /**
   * Spawn a floating damage number above a target.
   * @param normalizedDamage damage in HP-fraction units (same scale as leftHp)
   */
  private spawnDamageNumber(
    targetX: number,
    targetY: number,
    normalizedDamage: number,
    crit: boolean,
  ): void {
    this.damageNumbers.push({
      x: targetX + (Math.random() - 0.5) * this.s(36),
      y: targetY - this.s(70),
      vx: (Math.random() - 0.5) * this.s(0.7),
      vy: this.s(-1.9),
      life: 52,
      maxLife: 52,
      value: Math.max(1, Math.round(normalizedDamage * RpgCombatScene.HP_DISPLAY_SCALE)),
      crit,
    });
  }

  /**
   * Red/orange sparks flying outward — visual feedback for being hit.
   */
  private spawnDamageParticles(targetX: number, targetY: number): void {
    const damageColors = ['#FF3333', '#FF6600', '#FFAA00', '#FF0044', '#FFFFFF'];
    const count = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = this.s(3 + Math.random() * 4);
      this.particles.push({
        x: targetX + (Math.random() - 0.5) * this.s(40),
        y: targetY - this.s(30) + (Math.random() - 0.5) * this.s(40),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - this.s(2),
        life: 20 + Math.random() * 15,
        maxLife: 35,
        color: damageColors[Math.floor(Math.random() * damageColors.length)],
        size: this.s(3 + Math.random() * 4),
        type: 'spark',
      });
    }
  }

  /**
   * Binary search for the active lyric line at a given time.
   * Returns the index of the line whose start <= time < end, or -1 if between lines.
   */
  private findLineIndex(time: number): number {
    const lines = this._lyrics;
    if (lines.length === 0) return -1;

    // Linear scan is fine for typical lyric counts (< 200 lines)
    for (let i = 0; i < lines.length; i++) {
      if (time >= lines[i].start && time < lines[i].end) {
        return i;
      }
      // If we're past end but before next start, check if we just entered a new line
      if (i < lines.length - 1 && time >= lines[i].start && time < lines[i + 1].start) {
        return i;
      }
    }
    // Check if we're in the last line's range
    const last = lines[lines.length - 1];
    if (time >= last.start) return lines.length - 1;

    return -1;
  }

  reset(): void {
    this.cameraFocus = 'left';
    this.cameraX = this.leftX;
    this.cameraY = this.leftY;
    this.cameraZoom = 1.6;
    this.targetCameraX = this.leftX;
    this.targetCameraY = this.leftY;
    this.targetCameraZoom = 1.6;
    this.focusSwitchCount = 0;
    this.timeSinceLastSwitch = 0;
    this._currentLineIndex = -1;
    this.particles = [];
    this.damageNumbers = [];
    this.slashes = [];
    this.flashAlpha = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.leftAttackFrame = 0;
    this.rightAttackFrame = 0;
    this.leftRecoilFrame = 0;
    this.rightRecoilFrame = 0;
    // Reset cooldowns to NOW so both must wait their full cooldown before first attack.
    // Using 0 would make both fire instantly on the next threshold crossing (since now >> cooldown).
    // Must use the ACTIVE clock — stamping a wall-clock reading while the scene
    // compares against song time can put the cooldown arbitrarily far in the
    // future and permanently suppress attacks in the export.
    const resetTime = this._offline ? this._clockNow : performance.now() / 1000;
    this._leftLastAttackTime = resetTime;
    this._rightLastAttackTime = resetTime;
    this.leftHp = 1.0;
    this.rightHp = 1.0;
    this.leftHpTarget = 1.0;
    this.rightHpTarget = 1.0;
  }

  destroy(): void {
    this.leftImg = null;
    this.rightImg = null;
    this.bgImg = null;
    this.particles = [];
    this.damageNumbers = [];
    this.slashes = [];
  }
}

export default RpgCombatScene;
