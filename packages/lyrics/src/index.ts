/**
 * @threnic/lyrics — framework-agnostic lyric timing, parsing, rendering, and
 * timing diagnostics.
 *
 * Layers:
 *   - types/       the data contract (Word, LyricLineData, LyricTheme, ThrenicWord)
 *   - core/        pure logic (animation timing, parsers, converters, loader)
 *   - render/      Canvas2D renderer + injected FontRegistry seam
 *   - diagnostics/ timing linter
 */

// ── Types (the contract) ──────────────────────────────────────
export * from './types/core';
export * from './types/threnic-schema';
export type { TrackTitleConfig } from './types/track-title';

// ── Core logic ────────────────────────────────────────────────
export * from './core/AnimationController';
export * from './core/animationMap';
export * from './core/parsers';
export * from './core/converters';
export * from './core/loader';

// ── Rendering ─────────────────────────────────────────────────
export * from './render/CanvasLyricRenderer';
export * from './render/FontRegistry';
export * from './render/FrameAudio';
export * from './render/GlyphBuffer';
export * from './render/StyleRegistry';
export * from './render/styles';

// ── Diagnostics ───────────────────────────────────────────────
export * from './diagnostics/validateTiming';

// ── Logger (default; consumers may supply their own) ──────────
export { createLogger, logger } from './logger';
export type { Logger, LoggerConfig, LogLevel } from './logger';
