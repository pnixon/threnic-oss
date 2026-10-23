/**
 * Car Racing Scene — Outrun-style pseudo-3D side-scroller.
 *
 * A striped road scrolls toward the viewer using a phase accumulated from
 * audio.time * speed (monotonic — it never backtracks or spins, even on a
 * seek, because the accumulator is cleared on reset rather than reading raw
 * time into a modulo). A player car sits near the bottom-centre bobbing
 * slightly; procedural roadside sprites parallax past by depth; the sky
 * gradient sweeps day → dusk → night over the song via time/duration.
 *
 * Audio mapping (shared convention):
 * - beat        → nitro flash (white/orange overlay) + small screen shake
 * - amplitude   → scroll speed multiplier + roadside parallax rate
 * - bass        → ground rumble shake
 * - mid         → gentle horizontal road curve
 * - lyric start → a brief "boost" speed pulse (gear-shift cue)
 *
 * Backdrop: like rpgCombat, a backdrop is drawn ONLY when the user supplies a
 * custom `background` image. With no background the scene stays transparent and
 * Threnic's real background shows through beneath the road; the sky gradient is
 * only painted when a backdrop image is present (so an empty scene reveals the
 * app background rather than an opaque sky).
 */

import type { GameScene, AudioReactiveData, LyricLineTiming } from '../types';

// ─── Sprite loading ──────────────────────────────────────────────────────────

const DEFAULT_CAR_URL = '/assets/game-scenes/hero.png';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** A roadside object (palm / sign) that parallax-scrolls toward the viewer. */
interface RoadsideProp {
  /** Depth 0 (far, at horizon) → 1 (near, at bottom of screen). Monotonic up. */
  depth: number;
  /** -1 = left of road, +1 = right of road. */
  side: -1 | 1;
  /** 'palm' | 'sign' — cheap procedural shapes. */
  kind: 'palm' | 'sign';
  /** Per-prop colour variety. */
  hue: number;
}

/** An oncoming/leading traffic car travelling the road toward the viewer. */
interface TrafficCar {
  /** Depth 0 (far, horizon) → 1 (near). Monotonic up until recycled. */
  depth: number;
  /** Lane index 0..laneCount-1 the car occupies. */
  lane: number;
  /** Body colour. */
  color: string;
  /** Relative closing speed multiplier (some cars are slower/faster). */
  speedRel: number;
}

// ─── Scene ───────────────────────────────────────────────────────────────────

export class CarRacingScene implements GameScene {
  private width = 0;
  private height = 0;

  // Sprites
  private carImg: HTMLImageElement | null = null;
  private bgImg: HTMLImageElement | null = null;
  private imagesLoaded = false;
  private _spritesReady: Promise<void> | null = null;

  // Asset URLs. Background has NO default — empty means "no backdrop".
  private _carUrl = DEFAULT_CAR_URL;
  private _bgUrl = '';

  // Layout (re-derived in applyLayout).
  private horizonY = 0;
  private roadTopWidth = 0;
  private roadBottomWidth = 0;

  // ── Monotonic road phase ────────────────────────────────────────────────────
  // Accumulated from per-frame audio.time deltas × current speed. Never reads
  // raw time into a modulo, so it cannot jump backward on a seek — reset()
  // clears it. Used to phase the road stripes and to advance roadside props.
  private _roadPhase = 0;
  /** Previous audio.time, for deriving a clamped dt. -1 = uninitialized. */
  private _lastTime = -1;

  // Road curve. `_curve` is the CURRENT rendered horizontal offset (px at the
  // bottom edge), smoothed toward `_curveTarget`. The target is the sum of a
  // deterministic TURN sequence (a function of the monotonic road phase, so a
  // seek reproduces the exact same road) plus a small live `mid`-driven wobble.
  private _curve = 0;
  private _curveTarget = 0;

  // Roadside props, sorted implicitly by depth as they advance.
  private _props: RoadsideProp[] = [];

  // Oncoming/leading traffic cars travelling the road toward the viewer.
  private _traffic: TrafficCar[] = [];
  /** Road phase at which the next traffic car spawns (deterministic cadence). */
  private _nextSpawnPhase = 0;
  /** Player car lateral offset (px, scaled), drifts into turns + dodges cars. */
  private _playerX = 0;

  // Effects.
  private shakeX = 0;
  private shakeY = 0;
  private nitroFlash = 0; // 0–1 white/orange overlay alpha
  private carBob = 0;
  private boostPulse = 0; // brief speed bump from lyric line starts

  // Beat edge detection.
  private lastBeat = false;

  // Lyrics.
  private _lyrics: LyricLineTiming[] = [];
  private _currentLineIndex = -1;

  // Params.
  private _speed = 1;
  private _laneCount = 3;
  /** Which band drives the nitro flash. Spec default 'beat' → treated as bass. */
  private _nitroBand: 'bass' | 'mid' | 'treb' = 'bass';
  private _dayNight = true;
  /** Whether oncoming traffic cars spawn on the road. */
  private _trafficEnabled = true;

  // Offline / export mode.
  private _offline = false;
  private _clockNow = 0;

  // ── Resolution independence ────────────────────────────────────────────────
  private static readonly DESIGN_WIDTH = 1920;
  private static readonly DESIGN_HEIGHT = 1080;
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
    return Math.min(width / CarRacingScene.DESIGN_WIDTH, height / CarRacingScene.DESIGN_HEIGHT);
  }

  init(width: number, height: number): void {
    this.applyLayout(width, height);
    this.seedProps();
    this.loadSprites();
  }

  /**
   * Handle a canvas resolution change. Layout is proportional and every art
   * constant is scaled off `_scale`, so this re-derives layout and clears
   * transients whose coordinates belong to the old space. Roadside props use a
   * resolution-independent depth (0–1), so they survive a resize.
   */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;
    this.applyLayout(width, height);
    // Transients in screen/scaled space are cleared on a hard resolution cut.
    this.shakeX = 0;
    this.shakeY = 0;
  }

  /** Recompute canvas size, art scale, and road layout. */
  private applyLayout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this._scale = this.computeScale(width, height);
    // Horizon sits a little above the vertical centre.
    this.horizonY = height * 0.42;
    // Road is a trapezoid: narrow at the horizon, wide at the bottom.
    this.roadTopWidth = width * 0.06;
    this.roadBottomWidth = width * 0.9;
  }

  private seedProps(): void {
    this._props = [];
    // Distribute a handful of props across depth, alternating sides.
    const count = 8;
    for (let i = 0; i < count; i++) {
      this._props.push({
        depth: i / count,
        side: i % 2 === 0 ? -1 : 1,
        kind: i % 3 === 0 ? 'sign' : 'palm',
        hue: (i * 47) % 360,
      });
    }
  }

  /**
   * Deterministic road turn at a given road phase, in -1..1 (left..right).
   *
   * Turns are a function of the phase ALONE (no per-frame accumulation, no
   * RNG state), so the same stretch of road always bends the same way and a
   * seek reproduces it exactly — the same seek-safety guarantee the road phase
   * itself has. Two summed sines at incommensurate periods give a non-repeating
   * sequence of gentle sweepers and tighter bends without a lookup table.
   */
  private turnAt(phase: number): number {
    const a = Math.sin(phase * 0.35);
    const b = Math.sin(phase * 0.11 + 1.7);
    // Bias toward straighter stretches (cubic) so bends feel like events.
    const raw = (a * 0.6 + b * 0.4) ** 3 * 1.6;
    return Math.max(-1, Math.min(1, raw));
  }

  /** Spawn cadence + advance + recycle for oncoming traffic. */
  private updateTraffic(dt: number, speedMul: number): void {
    // Deterministic spawn: whenever the road phase crosses the next threshold,
    // spawn one car and schedule the next. Phase-keyed so export == preview.
    while (this._roadPhase >= this._nextSpawnPhase) {
      this.spawnCar(this._nextSpawnPhase);
      // Gap varies deterministically with the spawn phase (0.8..1.9 phase units).
      const gap = 0.8 + (Math.sin(this._nextSpawnPhase * 2.3) * 0.5 + 0.5) * 1.1;
      this._nextSpawnPhase += gap;
    }

    // Advance toward the viewer (near = faster via depth curve), recycle at 1.
    for (const c of this._traffic) {
      c.depth += (0.12 + c.depth * 0.9) * speedMul * c.speedRel * dt;
    }
    this._traffic = this._traffic.filter((c) => c.depth < 1.05);
    // Cap the pool so a very long song can't grow it unbounded.
    if (this._traffic.length > 24) {
      this._traffic.splice(0, this._traffic.length - 24);
    }
  }

  /** Add one traffic car, lane + colour + speed derived deterministically. */
  private spawnCar(seedPhase: number): void {
    const lane = Math.floor((Math.sin(seedPhase * 5.1) * 0.5 + 0.5) * this._laneCount);
    const palette = ['#3B82F6', '#EAB308', '#22C55E', '#EC4899', '#F97316', '#A855F7'];
    const color =
      palette[
        Math.floor((Math.sin(seedPhase * 9.7) * 0.5 + 0.5) * palette.length) % palette.length
      ];
    // Slower cars (0.4) the player overtakes, or faster oncoming (up to 0.9).
    const speedRel = 0.4 + (Math.sin(seedPhase * 3.3) * 0.5 + 0.5) * 0.5;
    this._traffic.push({
      depth: 0,
      lane: Math.min(this._laneCount - 1, Math.max(0, lane)),
      color,
      speedRel,
    });
  }

  /**
   * Lateral dodge (-1..1) the player applies to avoid the nearest close car.
   * Looks at cars in the near band (depth > 0.6); if one sits in the player's
   * current lane region, steer away from it. Cosmetic weaving, not collision.
   */
  private nearestCarDodge(): number {
    if (!this._traffic.length) return 0;
    // Player's normalized lane position from its current lateral offset.
    let nearest: TrafficCar | null = null;
    for (const c of this._traffic) {
      if (c.depth > 0.6 && (!nearest || c.depth > nearest.depth)) nearest = c;
    }
    if (!nearest) return 0;
    // Car lane centre in -1..1 across the road.
    const carPos = this._laneCount > 1 ? (nearest.lane + 0.5) / this._laneCount - 0.5 : 0;
    const playerPos = this._playerX / (this.s(340) * 0.12 + 1);
    // Steer to the opposite side of the car, weighted by how near it is.
    const proximity = (nearest.depth - 0.6) / 0.45; // 0..1
    return carPos > playerPos ? -proximity : proximity;
  }

  setLyrics(lines: LyricLineTiming[]): void {
    this._lyrics = lines;
    this._currentLineIndex = -1;
  }

  /**
   * Switch between live and offline (export) behaviour. Offline swaps the nitro
   * trigger source from the live audioStore to the per-frame audio, and the
   * clock from wall time to song time. The monotonic road phase already runs on
   * audio.time so it is export-safe either way. Cached last-time and shake are
   * cleared so a cross-clock toggle cannot inject a bogus dt.
   */
  setOffline(offline: boolean): void {
    if (offline === this._offline) return;
    this._offline = offline;
    this._lastTime = -1;
    this._clockNow = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    // Traffic is phase-derived and will re-spawn deterministically from the new
    // clock; clear the pool + spawn cursor so the two clocks don't overlap cars.
    this._traffic = [];
    this._nextSpawnPhase = this._roadPhase;
  }

  private async loadSprites(): Promise<void> {
    const load = (async () => {
      try {
        this.carImg = await loadImage(this._carUrl);
        this.imagesLoaded = true;
        if (this._bgUrl) {
          try {
            this.bgImg = await loadImage(this._bgUrl);
          } catch {
            this.bgImg = null;
          }
        } else {
          this.bgImg = null;
        }
      } catch (err) {
        console.error('[CarRacingScene] Failed to load sprites:', err);
      }
    })();
    this._spritesReady = load;
    return load;
  }

  /**
   * Resolves once assets have loaded (or failed). Bounded by a timeout because
   * an <img> pointed at a dead blob URL fires neither load nor error and would
   * otherwise hang the export forever.
   */
  whenAssetsReady(timeoutMs = 10_000): Promise<void> {
    if (!this._spritesReady) return Promise.resolve();
    return Promise.race([
      this._spritesReady,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!this.imagesLoaded) {
            console.warn('[CarRacingScene] Sprite load timed out; drawing without art');
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Set custom asset URLs and reload. `background` is special: an empty /
   * undefined URL clears the backdrop so the scene is a transparent overlay.
   * `left` (the car) keeps its default when not supplied.
   */
  setAssetUrls(urls: { left?: string; right?: string; background?: string }): void {
    let changed = false;
    if (urls.left && urls.left !== this._carUrl) {
      this._carUrl = urls.left;
      changed = true;
    }
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
   * Set scene params from config. All optional with defaults, matching
   * rpgCombat's tolerant style.
   */
  setParams(params: Record<string, number | string | boolean>): void {
    if (typeof params.speed === 'number' && Number.isFinite(params.speed)) {
      // Clamp to a sane positive range; 0/negative would freeze or reverse the
      // road, breaking the monotonic-phase guarantee.
      this._speed = Math.min(8, Math.max(0.05, params.speed));
    }
    if (typeof params.laneCount === 'number' && Number.isFinite(params.laneCount)) {
      this._laneCount = Math.min(6, Math.max(1, Math.round(params.laneCount)));
    }
    if (params.nitroBand === 'bass' || params.nitroBand === 'mid' || params.nitroBand === 'treb') {
      this._nitroBand = params.nitroBand;
    } else if (params.nitroBand === 'beat') {
      // Spec default 'beat' has no continuous band; drive nitro off bass.
      this._nitroBand = 'bass';
    }
    if (typeof params.dayNight === 'boolean') {
      this._dayNight = params.dayNight;
    }
    if (typeof params.traffic === 'boolean') {
      this._trafficEnabled = params.traffic;
    }
  }

  update(audio: AudioReactiveData): void {
    // ── dt from the media clock, clamped so first-frame / seek / clock-switch
    // can't inject a giant or negative step. ──
    let dt = this._lastTime >= 0 ? audio.time - this._lastTime : 1 / 60;
    if (!(dt > 0) || dt > 0.5) dt = 1 / 60;
    this._lastTime = audio.time;

    const now = this._offline ? audio.time : performance.now() / 1000;
    this._clockNow = now;

    // ── Lyric line start → boost pulse ──
    if (this._lyrics.length > 0) {
      const idx = this.findLineIndex(audio.time);
      if (idx >= 0 && idx !== this._currentLineIndex) {
        this._currentLineIndex = idx;
        this.boostPulse = 1;
      }
    }
    this.boostPulse *= 0.9;

    // ── Scroll speed: base speed × (1 + amplitude) × boost, all positive. ──
    const speedMul = this._speed * (1 + audio.amplitude * 1.5) * (1 + this.boostPulse * 0.8);

    // ── Monotonic road phase: strictly increases with time (speedMul > 0). ──
    this._roadPhase += dt * speedMul;

    // ── Advance roadside props by depth (near = fast), recycle at the front. ──
    for (const p of this._props) {
      // Parallax rate rises with amplitude; depth curve makes near props faster.
      const rate = (0.15 + p.depth * 0.85) * speedMul * dt;
      p.depth += rate;
      if (p.depth >= 1) {
        // Recycle to the horizon on the opposite side for variety.
        p.depth -= 1;
        p.side = p.side === -1 ? 1 : -1;
        p.hue = (p.hue + 137) % 360;
      }
    }

    // ── Road TURNS: the base curve is a deterministic function of the monotonic
    // road phase, so the same stretch of road always bends the same way and a
    // seek reproduces it exactly (export-safe). A small live mid-driven wobble
    // rides on top for audio reactivity. ──
    const turn = this.turnAt(this._roadPhase); // -1..1
    const wobble = (audio.mid - 0.3) * 0.5;
    this._curveTarget = (turn + wobble) * this.s(340);
    this._curve += (this._curveTarget - this._curve) * (1 - Math.exp(-dt / 0.35));

    // ── Traffic: spawn on a phase cadence, advance toward the viewer, recycle. ──
    if (this._trafficEnabled) {
      this.updateTraffic(dt, speedMul);
    }

    // ── Player car: eases toward the road-centre offset the turn implies (the
    // car leans into the bend), then nudges to dodge the nearest close car in
    // its lane. Purely cosmetic — no game-over, this is a music visual. ──
    let targetPlayerX = this._curve * 0.12; // lean into the turn
    const dodge = this.nearestCarDodge();
    targetPlayerX += dodge * this.s(90);
    this._playerX += (targetPlayerX - this._playerX) * (1 - Math.exp(-dt / 0.25));

    // ── Nitro flash from the configured band + beat edge. ──
    const beatJustHit = audio.beat && !this.lastBeat;
    this.lastBeat = audio.beat;
    const bandLevel =
      this._nitroBand === 'bass' ? audio.bass : this._nitroBand === 'mid' ? audio.mid : audio.treb;
    if (beatJustHit || bandLevel > 0.85) {
      this.nitroFlash = Math.max(this.nitroFlash, beatJustHit ? 0.5 : 0.3);
      // Small kick on the beat.
      const kick = this.s(beatJustHit ? 8 : 4);
      this.shakeX = (Math.random() - 0.5) * kick;
      this.shakeY = (Math.random() - 0.5) * kick;
    }
    this.nitroFlash *= 0.85;

    // ── Ground rumble from bass (only on strong hits). ──
    if (audio.bass > 0.85) {
      const intensity = this.s((audio.bass - 0.85) * 18);
      this.shakeX += (Math.random() - 0.5) * intensity;
      this.shakeY += (Math.random() - 0.5) * intensity;
    } else {
      this.shakeX *= 0.6;
      this.shakeY *= 0.6;
    }

    // ── Car bob (constant time-based idle + amplitude bounce). ──
    this.carBob = Math.sin(audio.time * 4) * this.s(4) + audio.amplitude * this.s(6);
  }

  render(audio: AudioReactiveData, ctx: CanvasRenderingContext2D): void {
    const hasBackdrop = !!(this.bgImg && this.imagesLoaded);

    // Transparent-first: clear every frame when there's no opaque backdrop, so
    // empty regions reveal Threnic's real background and nothing ghosts.
    if (!hasBackdrop) {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);

    // ── Sky / backdrop: only when a custom background image is present. ──
    // With no backdrop we skip the sky entirely so the app background shows.
    if (hasBackdrop) {
      this.drawBackdrop(ctx, audio);
    }

    // ── Road (drawn regardless — it's the scene). ──
    this.drawRoad(ctx);

    // ── Roadside props parallax over the road. ──
    this.drawProps(ctx);

    // ── Oncoming traffic on the road surface (far → near, under player). ──
    if (this._traffic.length) {
      this.drawTraffic(ctx);
    }

    // ── Player car near bottom-centre. ──
    this.drawCar(ctx);

    ctx.restore();

    // ── Screen-space nitro flash overlay. ──
    if (this.nitroFlash > 0.01) {
      ctx.globalAlpha = this.nitroFlash;
      ctx.fillStyle = this.nitroFlash > 0.35 ? '#FFFFFF' : '#FF8800';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────────

  /** Compute a day→dusk→night sky colour pair for the current song progress. */
  private skyColors(audio: AudioReactiveData): [string, string] {
    if (!this._dayNight || audio.duration <= 0) {
      // Static daytime sky when day/night is off or duration is unknown.
      return ['#4FA9E8', '#BFE4FF'];
    }
    const p = Math.min(1, Math.max(0, audio.time / audio.duration));
    // Interpolate top colour day → dusk → night.
    const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    // Three-stop gradient over progress.
    let top: [number, number, number];
    let bot: [number, number, number];
    if (p < 0.5) {
      const t = p / 0.5;
      top = [lerp(79, 234, t), lerp(169, 122, t), lerp(232, 89, t)];
      bot = [lerp(191, 255, t), lerp(228, 176, t), lerp(255, 120, t)];
    } else {
      const t = (p - 0.5) / 0.5;
      top = [lerp(234, 14, t), lerp(122, 18, t), lerp(89, 46, t)];
      bot = [lerp(255, 40, t), lerp(176, 28, t), lerp(120, 72, t)];
    }
    return [`rgb(${top[0]},${top[1]},${top[2]})`, `rgb(${bot[0]},${bot[1]},${bot[2]})`];
  }

  private drawBackdrop(ctx: CanvasRenderingContext2D, audio: AudioReactiveData): void {
    // A custom background image (skyline strip) takes precedence over the
    // procedural sky gradient. Draw it above the horizon.
    if (this.bgImg && this.imagesLoaded) {
      ctx.drawImage(this.bgImg, 0, 0, this.width, this.horizonY);
    } else {
      const [top, bot] = this.skyColors(audio);
      const grad = ctx.createLinearGradient(0, 0, 0, this.horizonY);
      grad.addColorStop(0, top);
      grad.addColorStop(1, bot);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.width, this.horizonY);
    }
  }

  /**
   * Draw the pseudo-3D road as horizontal bands from the horizon to the bottom.
   * Band colour alternates (light/dark tarmac) based on the monotonic road
   * phase, so the stripes appear to scroll toward the viewer. Edge stripes and
   * lane dividers scale with perspective.
   */
  private drawRoad(ctx: CanvasRenderingContext2D): void {
    const cx = this.width / 2;
    const bands = 40;
    const startY = this.horizonY;
    const endY = this.height;
    const span = endY - startY;

    for (let i = 0; i < bands; i++) {
      // Perspective: nearer bands (larger t) are taller.
      const t0 = i / bands;
      const t1 = (i + 1) / bands;
      // Ease so bands bunch up near the horizon.
      const y0 = startY + span * (t0 * t0);
      const y1 = startY + span * (t1 * t1);

      // Road width interpolates from top (narrow) to bottom (wide) by depth.
      const wTop = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * (t0 * t0);
      const wBot = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * (t1 * t1);

      // Horizontal curve offset scales with depth (near curves more).
      const curveTop = this._curve * (t0 * t0);
      const curveBot = this._curve * (t1 * t1);

      // Alternating tarmac colour, phased by the monotonic road phase so it
      // scrolls. Phase * (near-fast) makes near bands cycle faster.
      const stripe = Math.floor(this._roadPhase * 3 + i) % 2 === 0;
      ctx.fillStyle = stripe ? '#3A3A44' : '#2E2E38';

      // Draw the band as a quad (approximate with a filled path).
      const lTop = cx + curveTop - wTop / 2;
      const rTop = cx + curveTop + wTop / 2;
      const lBot = cx + curveBot - wBot / 2;
      const rBot = cx + curveBot + wBot / 2;
      ctx.beginPath();
      ctx.moveTo(lTop, y0);
      ctx.lineTo(rTop, y0);
      ctx.lineTo(rBot, y1);
      ctx.lineTo(lBot, y1);
      ctx.closePath();
      ctx.fill();

      // Edge stripes (red/white rumble).
      const edgeW = Math.max(1, this.s(6)) * (0.3 + t0);
      ctx.fillStyle = stripe ? '#E23B3B' : '#EDEDED';
      ctx.fillRect(lBot - edgeW, y1 - Math.max(1, y1 - y0), edgeW, Math.max(1, y1 - y0));
      ctx.fillRect(rBot, y1 - Math.max(1, y1 - y0), edgeW, Math.max(1, y1 - y0));

      // Lane dividers (dashed centre lines), only on light bands.
      if (stripe && this._laneCount > 1) {
        ctx.fillStyle = '#F5D24A';
        for (let lane = 1; lane < this._laneCount; lane++) {
          const frac = lane / this._laneCount;
          const xTop = lTop + (rTop - lTop) * frac;
          const xBot = lBot + (rBot - lBot) * frac;
          const dashW = Math.max(1, this.s(3)) * (0.3 + t0);
          ctx.fillRect((xTop + xBot) / 2 - dashW / 2, y0, dashW, Math.max(1, y1 - y0));
        }
      }
    }
  }

  private drawProps(ctx: CanvasRenderingContext2D): void {
    const cx = this.width / 2;
    const startY = this.horizonY;
    const span = this.height - startY;

    // Sort near-to-far so near props paint over far ones.
    const sorted = [...this._props].sort((a, b) => a.depth - b.depth);
    for (const p of sorted) {
      const t = p.depth;
      const y = startY + span * (t * t);
      const roadW = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * (t * t);
      const curve = this._curve * (t * t);
      // Position just outside the road edge.
      const edgeX = cx + curve + p.side * (roadW / 2 + this.s(40) * (0.3 + t));
      const scale = 0.15 + t; // perspective size

      if (p.kind === 'palm') {
        this.drawPalm(ctx, edgeX, y, scale);
      } else {
        this.drawSign(ctx, edgeX, y, scale, p.hue);
      }
    }
  }

  private drawPalm(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    const trunkH = this.s(90) * scale;
    const trunkW = Math.max(1, this.s(8) * scale);
    ctx.fillStyle = '#6B4A2B';
    ctx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
    // Fronds as a green blob.
    const r = this.s(26) * scale;
    ctx.fillStyle = '#2FA34A';
    ctx.beginPath();
    ctx.arc(x, y - trunkH, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSign(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    hue: number,
  ): void {
    const postH = this.s(70) * scale;
    const postW = Math.max(1, this.s(6) * scale);
    ctx.fillStyle = '#888888';
    ctx.fillRect(x - postW / 2, y - postH, postW, postH);
    const boardW = this.s(46) * scale;
    const boardH = this.s(34) * scale;
    ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
    ctx.fillRect(x - boardW / 2, y - postH - boardH, boardW, boardH);
  }

  /**
   * Road-surface X for a lane centre at a given depth, following the same
   * perspective + curve as drawRoad so cars sit ON the road.
   */
  private laneX(lane: number, t: number): number {
    const cx = this.width / 2;
    const roadW = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * (t * t);
    const curve = this._curve * (t * t);
    const left = cx + curve - roadW / 2;
    const frac = this._laneCount > 0 ? (lane + 0.5) / this._laneCount : 0.5;
    return left + roadW * frac;
  }

  private drawTraffic(ctx: CanvasRenderingContext2D): void {
    const startY = this.horizonY;
    const span = this.height - startY;
    // Far → near so nearer cars paint over farther ones.
    const sorted = [...this._traffic].sort((a, b) => a.depth - b.depth);
    for (const c of sorted) {
      const t = c.depth;
      const y = startY + span * (t * t);
      const x = this.laneX(c.lane, t);
      const scale = 0.12 + t * 0.9; // perspective size
      const bodyW = this.s(120) * scale;
      const bodyH = this.s(52) * scale;
      // Body.
      ctx.fillStyle = c.color;
      ctx.fillRect(x - bodyW / 2, y - bodyH, bodyW, bodyH);
      // Cabin.
      ctx.fillStyle = '#1E1E28';
      ctx.fillRect(
        x - bodyW * 0.3,
        y - bodyH - this.s(20) * scale,
        bodyW * 0.6,
        this.s(22) * scale,
      );
      // Rear lights (we're behind them → red).
      ctx.fillStyle = '#FF4433';
      const lw = Math.max(1, this.s(9) * scale);
      const lh = Math.max(1, this.s(10) * scale);
      ctx.fillRect(x - bodyW / 2, y - bodyH + this.s(4) * scale, lw, lh);
      ctx.fillRect(x + bodyW / 2 - lw, y - bodyH + this.s(4) * scale, lw, lh);
    }
  }

  private drawCar(ctx: CanvasRenderingContext2D): void {
    const x = this.width / 2 + this._playerX;
    const y = this.height * 0.86 + this.carBob;

    if (this.carImg && this.imagesLoaded) {
      const spriteH = this.s(160);
      const spriteW = (this.carImg.width / this.carImg.height) * spriteH;
      ctx.drawImage(this.carImg, x - spriteW / 2, y - spriteH, spriteW, spriteH);
    } else {
      // Procedural placeholder car: chunky pixel-art body.
      const bodyW = this.s(140);
      const bodyH = this.s(60);
      ctx.fillStyle = '#D8322F';
      ctx.fillRect(x - bodyW / 2, y - bodyH, bodyW, bodyH);
      // Cabin.
      ctx.fillStyle = '#2E2E38';
      ctx.fillRect(x - bodyW * 0.28, y - bodyH - this.s(26), bodyW * 0.56, this.s(30));
      // Wheels.
      ctx.fillStyle = '#111111';
      const wheelR = this.s(16);
      ctx.beginPath();
      ctx.arc(x - bodyW * 0.32, y, wheelR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + bodyW * 0.32, y, wheelR, 0, Math.PI * 2);
      ctx.fill();
      // Tail lights.
      ctx.fillStyle = '#FFCC33';
      ctx.fillRect(x - bodyW / 2, y - bodyH + this.s(6), this.s(10), this.s(12));
      ctx.fillRect(x + bodyW / 2 - this.s(10), y - bodyH + this.s(6), this.s(10), this.s(12));
    }
  }

  /**
   * Find the active lyric line at a time, or -1 if between lines. Mirrors
   * rpgCombat's linear scan (fine for typical lyric counts).
   */
  private findLineIndex(time: number): number {
    const lines = this._lyrics;
    if (lines.length === 0) return -1;
    for (let i = 0; i < lines.length; i++) {
      if (time >= lines[i].start && time < lines[i].end) return i;
      if (i < lines.length - 1 && time >= lines[i].start && time < lines[i + 1].start) return i;
    }
    const last = lines[lines.length - 1];
    if (time >= last.start) return lines.length - 1;
    return -1;
  }

  reset(): void {
    // Clear the monotonic phase accumulator + last-time so a seek to 0 starts
    // the road fresh instead of jumping.
    this._roadPhase = 0;
    this._lastTime = -1;
    this._curve = 0;
    this._curveTarget = 0;
    this._currentLineIndex = -1;
    this.shakeX = 0;
    this.shakeY = 0;
    this.nitroFlash = 0;
    this.boostPulse = 0;
    this.carBob = 0;
    this.lastBeat = false;
    this._traffic = [];
    this._nextSpawnPhase = 0;
    this._playerX = 0;
    this.seedProps();
  }

  destroy(): void {
    this.carImg = null;
    this.bgImg = null;
    this._props = [];
    this._traffic = [];
  }
}

export default CarRacingScene;
