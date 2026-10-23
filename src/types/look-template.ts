/**
 * Look Template Types (Stage 4 — portable "Looks")
 *
 * A `.threnic-look` document is a portable, versioned snapshot of ONE track's
 * *visual identity* — its `effectsConfig`, its `lyricTheme`, and the small set
 * of blob-carrying assets that config references — serialized to a self-
 * contained JSON document with inline `data:` URIs (LLD §6, "data:URI
 * portable"; single track, not a zip).
 *
 * A Look is deliberately NOT a project: it carries no audio, no lyrics timing,
 * no keyframes, no video-clip timeline. It is the "how it looks" layer that a
 * user can lift off one track and drop onto another, and it is imported through
 * the EXISTING {@link import('@/stores/projectStore') projectStore.applyPresetLook}
 * mutation — never a new one.
 *
 * This module is TYPES ONLY — no engine, no store imports — so both the
 * serializer and any future UI can depend on it without pulling in runtime.
 */

import type { EffectsConfig } from '@/types/effects';
import type { LyricTheme } from '@/types/lyrics';
import type { AudioRoutingTable } from '@/types/effects/audio-routing';

/**
 * Schema envelope tag. It is the FIRST field of every {@link LookTemplate} and
 * the single value {@link import('@/lib/looks/serialize').migrateLook} keys the
 * document version off of. Bump the numeric suffix on any breaking change and
 * add a migration branch — never repurpose `threnic.look/1`.
 */
export const SCHEMA_TAG = 'threnic.look/1' as const;

/** The literal type of {@link SCHEMA_TAG}. */
type LookSchemaTag = typeof SCHEMA_TAG;

/** What class of resource a packed {@link LookAsset} holds. */
export type LookAssetKind = 'image' | 'lut' | 'shader' | 'media';

/**
 * One packed asset a Look references by id. Exactly one of `data` (an inline
 * `data:` URI — the portable, self-contained form) or `url` (a public path that
 * needs no packing, e.g. a `/public` asset or an `https:` URL) is present.
 *
 * `bytes` is the decoded size of the payload, used to enforce the export size
 * cap and to warn before a Look grows unwieldy. For a `data:` asset it is the
 * decoded byte length; for a `url` asset it is 0 (nothing is inlined).
 */
export interface LookAsset {
  /** Stable id the config's URL refs are rewritten to (`look-asset:<n>`). */
  id: string;
  /** Class of resource (advisory; drives no branching in apply). */
  kind: LookAssetKind;
  /** Inline `data:` URI payload. Present for packed blob/data assets. */
  data?: string;
  /** Public URL/path left un-inlined. Present for pass-through assets. */
  url?: string;
  /** Decoded payload size in bytes (0 for `url`-only assets). */
  bytes: number;
}

/**
 * A portable Look document. `schema` is first so a reader can version-gate
 * before trusting any other field.
 *
 * `audioRouting` is mirrored top-level ONLY as a convenience read: the source
 * of truth stays inside `effectsConfig` (`shaderOverlay.audioRouting` and each
 * shaderFx instance's `shader.audioRouting`), which round-trips for free. Apply
 * does not read the top-level copy back into config.
 */
export interface LookTemplate {
  /** Version envelope — MUST be the first field. */
  schema: LookSchemaTag;
  /** Stable document id (generated at serialize time). */
  id: string;
  /** Human-readable name (defaults to the source track name). */
  name: string;
  /** Optional author attribution. */
  author?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** App/project version that produced this document (provenance only). */
  appVersion: string;
  /** The track's full effects configuration (assets already packed). */
  effectsConfig: EffectsConfig;
  /** Optional lyric theme overrides merged onto the target track. */
  lyricTheme?: Partial<LyricTheme>;
  /**
   * Convenience top-level mirror of the shader overlay's audio routing table.
   * SOURCE OF TRUTH remains inside `effectsConfig`; this is not read back on
   * apply. Present only when `effectsConfig.shaderOverlay.audioRouting` exists.
   */
  audioRouting?: AudioRoutingTable;
  /** Packed assets referenced by `effectsConfig` via `look-asset:<n>` ids. */
  assets: LookAsset[];
}
