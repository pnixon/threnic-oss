/**
 * Look serialize / apply / migrate (Stage 4).
 *
 * - {@link serializeLook}: read a Track's visual identity (effectsConfig +
 *   lyricsTheme + backgroundImage), pack its blob-carrying assets, and stamp a
 *   portable {@link LookTemplate}.
 * - {@link applyLook}: validate + migrate an UNTRUSTED raw document, reject
 *   unknown effect instance types, rehydrate assets, and hand the result to the
 *   EXISTING `projectStore.applyPresetLook` mutation. No new mutation is created.
 * - {@link migrateLook}: pure schema-tag validation + version normalization.
 *
 * The UI export/import button (a Stage-4 follow-up, NOT wired here) hooks into
 * the Effects tab: an "Export Look" action calls {@link serializeLook} for the
 * selected track and downloads the JSON; an "Import Look" action reads a file,
 * parses JSON, and calls {@link applyLook}(parsed, selectedTrackId).
 */

import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects';
import { POST_PROCESSING_EFFECT_TYPES, SCENE_EFFECT_TYPES } from '@/types/effects';
import type { LyricTheme } from '@/types/lyrics';
import type { AudioRoutingTable } from '@/types/effects/audio-routing';
import type { Track } from '@/contexts/types';
import { PROJECT_VERSION } from '@/types/project';
import { projectStore } from '@/stores/projectStore';
import { createLogger } from '@/utils/logger';
import {
  packEffectsAssets,
  rehydrateEffectsAssets,
  fetchBlobToDataUri,
  type BlobToDataUri,
  type PackOptions,
} from './assets';
import type { LookTemplate } from '@/types/look-template';
import { SCHEMA_TAG } from '@/types/look-template';

const logger = createLogger({ enabled: true, prefix: 'Looks' });

/** Every accepted effect instance type (scene + post-processing). */
const KNOWN_EFFECT_TYPES: ReadonlySet<string> = new Set<string>([
  ...SCENE_EFFECT_TYPES,
  ...POST_PROCESSING_EFFECT_TYPES,
]);

/** Options for {@link serializeLook}. */
interface SerializeLookOptions {
  /** Optional author attribution stamped into the document. */
  author?: string;
  /** Injected blob→data-URI resolver (defaults to a real fetch). */
  resolve?: BlobToDataUri;
  /** Forwarded to the asset packer (size cap etc.). */
  pack?: Omit<PackOptions, 'resolve'>;
}

/** Generate a stable-ish document id without pulling in a uuid dep. */
function makeLookId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `look-${crypto.randomUUID()}`;
  }
  return `look-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Serialize a track's visual identity into a portable {@link LookTemplate}.
 * Async because packing `blob:` assets requires reading them into `data:` URIs.
 * The returned document is self-contained (inline assets) and safe to write to
 * a `.threnic-look` file. Also returns any packing warnings (dropped local
 * assets, size cap) so the caller can surface them.
 */
export async function serializeLook(
  track: Track,
  name: string,
  options: SerializeLookOptions = {},
): Promise<{ look: LookTemplate; warnings: string[] }> {
  const sourceConfig = track.effectsConfig;
  if (!sourceConfig) {
    throw new Error('Cannot serialize a Look from a track with no effectsConfig.');
  }

  const resolve = options.resolve ?? fetchBlobToDataUri;
  const {
    config: packedConfig,
    assets: configAssets,
    warnings,
  } = await packEffectsAssets(sourceConfig, { ...options.pack, resolve });

  // Track-level background image is NOT part of effectsConfig; pack it into the
  // asset list too and stash the id on the config's `lyricTheme`-adjacent path?
  // No — applyPresetLook takes backgroundImageUrl separately, so we carry the
  // packed bg as its own asset and rehydrate it back into backgroundImageUrl on
  // apply. Reuse the same asset-id scheme by appending after config assets.
  const assets = [...configAssets];
  const bg = track.backgroundImage;
  if (bg && typeof bg === 'string') {
    if (bg.startsWith('blob:')) {
      try {
        const dataUri = await resolve(bg);
        assets.push({
          id: BACKGROUND_ASSET_ID,
          kind: 'image',
          data: dataUri,
          bytes: dataUriByteLen(dataUri),
        });
      } catch {
        warnings.push('Could not pack track background image (dropped).');
      }
    } else if (isPortableRef(bg)) {
      assets.push({ id: BACKGROUND_ASSET_ID, kind: 'image', url: bg, bytes: 0 });
    }
  }

  const audioRouting: AudioRoutingTable | undefined = packedConfig.shaderOverlay?.audioRouting;

  const look: LookTemplate = {
    schema: SCHEMA_TAG,
    id: makeLookId(),
    name: name || track.name || 'Untitled Look',
    author: options.author,
    createdAt: new Date().toISOString(),
    appVersion: PROJECT_VERSION,
    effectsConfig: packedConfig,
    lyricTheme: track.lyricsTheme as Partial<LyricTheme> | undefined,
    ...(audioRouting ? { audioRouting } : {}),
    assets,
  };

  return { look, warnings };
}

/** Reserved asset id for the track-level background image. */
const BACKGROUND_ASSET_ID = 'look-asset:bg';

function isPortableRef(url: string): boolean {
  return (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/')
  );
}

function dataUriByteLen(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUri.slice(comma + 1);
  const meta = dataUri.slice(0, comma);
  if (!meta.includes(';base64')) return payload.length;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Validate + normalize an UNTRUSTED raw value into a {@link LookTemplate}, or
 * return null if it is not a Look document we can read. PURE — no I/O, no store.
 * Only the schema-tag envelope is version-gated here; deeper migration branches
 * are added as new schema versions ship.
 */
export function migrateLook(raw: unknown): LookTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;

  if (doc.schema !== SCHEMA_TAG) return null;
  if (!doc.effectsConfig || typeof doc.effectsConfig !== 'object') return null;

  const assets = Array.isArray(doc.assets) ? (doc.assets as LookTemplate['assets']) : [];

  return {
    schema: SCHEMA_TAG,
    id: typeof doc.id === 'string' ? doc.id : makeLookId(),
    name: typeof doc.name === 'string' ? doc.name : 'Imported Look',
    author: typeof doc.author === 'string' ? doc.author : undefined,
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString(),
    appVersion: typeof doc.appVersion === 'string' ? doc.appVersion : 'unknown',
    effectsConfig: doc.effectsConfig as EffectsConfig,
    lyricTheme:
      doc.lyricTheme && typeof doc.lyricTheme === 'object'
        ? (doc.lyricTheme as Partial<LyricTheme>)
        : undefined,
    audioRouting:
      doc.audioRouting && typeof doc.audioRouting === 'object'
        ? (doc.audioRouting as AudioRoutingTable)
        : undefined,
    assets,
  };
}

/**
 * Drop any effect instance whose `type` is not a known scene/post-processing
 * type. UNTRUSTED input — a hand-edited or malicious Look could name an unknown
 * type that the renderer/migrator would choke on. Returns the filtered list and
 * the dropped type names for warning.
 */
function rejectUnknownEffectTypes(config: EffectsConfig): {
  config: EffectsConfig;
  droppedTypes: string[];
} {
  const instances = config.effectInstances;
  if (!Array.isArray(instances) || instances.length === 0) {
    return { config, droppedTypes: [] };
  }
  const droppedTypes: string[] = [];
  // Untrusted input: an instance's `type` may be a string that matches no
  // member of the EffectInstance union, so walk them as loose records (a
  // narrowed `inst.type` on the union would collapse to `never`).
  const raw = instances as unknown as Array<{ type?: unknown } | null | undefined>;
  const kept = raw.filter((inst) => {
    if (!inst || typeof inst.type !== 'string') {
      droppedTypes.push(String(inst?.type ?? 'null'));
      return false;
    }
    if (!KNOWN_EFFECT_TYPES.has(inst.type)) {
      droppedTypes.push(inst.type);
      return false;
    }
    return true;
  }) as unknown as EffectInstance[];
  if (droppedTypes.length === 0) return { config, droppedTypes: [] };
  return { config: { ...config, effectInstances: kept }, droppedTypes };
}

/** Result of {@link applyLook}. */
type ApplyLookResult = { ok: true; warnings: string[] } | { ok: false; reason: string };

/**
 * Import a Look onto a track. Validates the schema, migrates, REJECTS unknown
 * effect instance types (untrusted input), rehydrates packed assets, then
 * routes everything through the EXISTING `projectStore.applyPresetLook`
 * mutation — which handles blob-URL revocation, null-instance sanitising,
 * legacy migration, and the lyricTheme merge.
 */
export async function applyLook(raw: unknown, trackId: string): Promise<ApplyLookResult> {
  const look = migrateLook(raw);
  if (!look) {
    return {
      ok: false,
      reason: `Not a recognized Look document (expected schema "${SCHEMA_TAG}").`,
    };
  }
  if (!trackId) {
    return { ok: false, reason: 'No target track id provided.' };
  }

  const warnings: string[] = [];

  // 1. Reject unknown effect instance types (untrusted input).
  const { config: cleanedConfig, droppedTypes } = rejectUnknownEffectTypes(look.effectsConfig);
  if (droppedTypes.length > 0) {
    warnings.push(
      `Dropped ${droppedTypes.length} unknown effect type${droppedTypes.length === 1 ? '' : 's'}: ${droppedTypes.join(', ')}.`,
    );
  }

  // 2. Rehydrate packed assets back into the config (data: URIs / urls).
  const rehydratedConfig = rehydrateEffectsAssets(cleanedConfig, look.assets);

  // 3. Rehydrate the track-level background image (packed separately).
  const bgAsset = look.assets.find((a) => a.id === BACKGROUND_ASSET_ID);
  const backgroundImageUrl = bgAsset ? (bgAsset.data ?? bgAsset.url) : undefined;

  // 4. Route through the EXISTING mutation. Do NOT write a new one.
  try {
    projectStore.getState().applyPresetLook(trackId, {
      effectsConfig: rehydratedConfig,
      lyricTheme: look.lyricTheme,
      ...(backgroundImageUrl !== undefined ? { backgroundImageUrl } : {}),
    });
  } catch (err) {
    logger.error('applyPresetLook failed while applying Look', err as Error);
    return { ok: false, reason: `Failed to apply Look: ${(err as Error).message}` };
  }

  return { ok: true, warnings };
}
