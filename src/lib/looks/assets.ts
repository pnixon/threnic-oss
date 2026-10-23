/**
 * Look asset packing (Stage 4) — PURE, no store / React imports.
 *
 * A Look must be portable, so any URL the effects config points at that would
 * NOT survive leaving this browser tab — a `blob:` object URL (revoked on
 * reload) — has to be inlined as a `data:` URI before the Look is serialized,
 * and rewritten back to a fresh reference on import. This module does exactly
 * that, and nothing else: it takes an {@link EffectsConfig}, walks the known
 * blob-carrying URL fields, and returns a packed clone plus the collected
 * {@link LookAsset}s ({@link packEffectsAssets}); the inverse
 * ({@link rehydrateEffectsAssets}) folds the assets back in.
 *
 * WHAT IS PACKED (blob-carrying URL fields — see Stage 4 seams):
 *   - effectsConfig.video.url
 *   - effectsConfig.pixi.image
 *   - effectsConfig.slideshow.items[].url
 *   - effectsConfig.postProcessing.oldFilm.grainBundle[]      (URL array)
 *   - effectsConfig.postProcessing.noiseOverlay.grainBundle[] (URL array)
 * (track-level backgroundImage is packed by the serializer, not here — it is
 * not part of effectsConfig; it round-trips via applyPresetLook.backgroundImageUrl.)
 *
 * WHAT IS DROPPED (with a warning): IndexedDB *asset-KEY* fields. These are not
 * URLs and point at CUSTOMER-uploaded assets that MUST stay local (never travel
 * in a portable doc). We clear them so the imported Look renders without them:
 *   - effectsConfig.postProcessing.bgImageOverlay.imageAssetId
 *   - shaderFx instances: config.shader glsl channels[].assetId + buffers[].channels[].assetId
 *   (the top-level shaderOverlay.* glsl fields, if ever populated, likewise)
 *
 * LEFT AS-IS: effectsConfig.gaussianSplat.url is a public path, not a blob.
 * `data:`/`http(s):`/`/public` refs pass through untouched (already portable).
 */

import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects';
import type { GuestChannel } from '@/engine/gpu/glsl/types';
import type { LookAsset, LookAssetKind } from '@/types/look-template';

/** Prefix for generated asset ids. */
const ASSET_ID_PREFIX = 'look-asset:';

/**
 * Default soft cap on total packed bytes (24 MB). A Look over this still packs
 * — the cap never blocks — but a warning is emitted so an over-large portable
 * doc is surfaced rather than silently shipped. Override via {@link PackOptions}.
 */
const DEFAULT_LOOK_SIZE_CAP_BYTES = 24 * 1024 * 1024;

/** How a `blob:`/`data:` URL is resolved to a `data:` URI (async, injectable). */
export type BlobToDataUri = (url: string) => Promise<string>;

/** Options for {@link packEffectsAssets}. */
export interface PackOptions {
  /**
   * Resolver from a `blob:` (or `data:`) URL to a `data:` URI. Injected so the
   * module stays pure/testable — production passes {@link fetchBlobToDataUri}.
   */
  resolve?: BlobToDataUri;
  /** Soft byte cap for a warning (default {@link DEFAULT_LOOK_SIZE_CAP_BYTES}). */
  sizeCapBytes?: number;
}

/** Result of {@link packEffectsAssets}. */
interface PackResult {
  /** Deep clone of the input config with URL refs rewritten to asset ids. */
  config: EffectsConfig;
  /** Assets collected during the walk (inline `data:` or pass-through `url`). */
  assets: LookAsset[];
  /** Human-readable warnings (dropped customer assets, size cap, resolve fails). */
  warnings: string[];
}

/**
 * Production {@link BlobToDataUri}: fetch the (blob/object) URL and FileReader
 * it into a `data:` URI. Lives here so callers get one canonical impl, but is
 * INJECTED — the pure functions never call `fetch` themselves.
 */
export async function fetchBlobToDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/** True for a ref that needs inlining before it can leave this tab. */
function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:');
}

/** True for a ref that is already portable (inline data or public network/path). */
function isPortableUrl(url: string): boolean {
  return (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/')
  );
}

/** Decoded byte length of a `data:` URI's base64 payload (0 if not base64). */
function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  if (comma < 0) return 0;
  const meta = dataUri.slice(0, comma);
  const payload = dataUri.slice(comma + 1);
  if (!meta.includes(';base64')) {
    // URL-encoded (rare for our packing) — approximate by decoded length.
    try {
      return decodeURIComponent(payload).length;
    } catch {
      return payload.length;
    }
  }
  // base64 → bytes: 4 chars per 3 bytes, minus padding.
  const len = payload.length;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/** structuredClone-equivalent deep clone that also breaks shared refs. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Collector that mints stable ids and dedupes identical resolved payloads so
 * the same blob referenced twice packs once.
 */
class AssetCollector {
  private assets: LookAsset[] = [];
  private byOriginal = new Map<string, string>(); // original url -> asset id
  private counter = 0;

  /** Register a resolved data URI (or pass-through url) and return its asset id. */
  add(originalUrl: string, resolved: string, kind: LookAssetKind): string {
    const existing = this.byOriginal.get(originalUrl);
    if (existing) return existing;

    const id = `${ASSET_ID_PREFIX}${this.counter++}`;
    const asset: LookAsset = resolved.startsWith('data:')
      ? { id, kind, data: resolved, bytes: dataUriBytes(resolved) }
      : { id, kind, url: resolved, bytes: 0 };
    this.assets.push(asset);
    this.byOriginal.set(originalUrl, id);
    return id;
  }

  list(): LookAsset[] {
    return this.assets;
  }

  totalBytes(): number {
    return this.assets.reduce((sum, a) => sum + a.bytes, 0);
  }
}

/**
 * Pack an effects config for a portable Look. Async because `blob:` refs must
 * be read into `data:` URIs. Returns a rewritten CLONE (the input is never
 * mutated), the collected assets, and warnings.
 */
export async function packEffectsAssets(
  config: EffectsConfig,
  options: PackOptions = {},
): Promise<PackResult> {
  const resolve = options.resolve ?? fetchBlobToDataUri;
  const sizeCap = options.sizeCapBytes ?? DEFAULT_LOOK_SIZE_CAP_BYTES;
  const out = deepClone(config);
  const collector = new AssetCollector();
  const warnings: string[] = [];

  /**
   * Resolve one URL ref to an asset id (packing a blob, passing through a
   * portable url), or return null to leave the field untouched (empty/unknown).
   */
  const packRef = async (
    url: string | null | undefined,
    kind: LookAssetKind,
  ): Promise<string | null> => {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith(ASSET_ID_PREFIX)) return url; // already an asset ref
    if (isBlobUrl(url)) {
      try {
        const dataUri = await resolve(url);
        return collector.add(url, dataUri, kind);
      } catch {
        warnings.push(`Could not resolve blob asset (dropped): ${url.slice(0, 48)}…`);
        return null;
      }
    }
    if (isPortableUrl(url)) {
      // A `data:` inline is packed as an asset so import handling is uniform;
      // an http(s) / `/public` path passes through as a url-only asset.
      const kindForRef: LookAssetKind = kind;
      return collector.add(url, url, kindForRef);
    }
    // Unknown scheme — leave as-is.
    return null;
  };

  // video.url
  if (out.video) {
    const id = await packRef(out.video.url, 'media');
    if (id) out.video.url = id;
  }

  // pixi.image
  if (out.pixi) {
    const id = await packRef(out.pixi.image ?? undefined, 'image');
    if (id) out.pixi.image = id;
  }

  // slideshow.items[].url
  if (out.slideshow?.items?.length) {
    for (const item of out.slideshow.items) {
      const id = await packRef(item.url, item.type === 'video' ? 'media' : 'image');
      if (id) item.url = id;
    }
  }

  // postProcessing grain bundles (URL arrays)
  const pp = out.postProcessing;
  if (pp?.oldFilm?.grainBundle?.length) {
    pp.oldFilm.grainBundle = await packUrlArray(pp.oldFilm.grainBundle, packRef);
  }
  if (pp?.noiseOverlay?.grainBundle?.length) {
    pp.noiseOverlay.grainBundle = await packUrlArray(pp.noiseOverlay.grainBundle, packRef);
  }

  // ── Drop customer-local IndexedDB asset-KEY fields (never portable) ──
  if (pp?.bgImageOverlay?.imageAssetId) {
    warnings.push(
      'Dropped secondary background image (bgImageOverlay.imageAssetId): local IndexedDB asset stays on the source machine.',
    );
    pp.bgImageOverlay.imageAssetId = undefined;
  }
  dropShaderFxLocalAssetIds(out.effectInstances, warnings);
  // Top-level shaderOverlay carries no glsl channels today, but guard anyway.

  const total = collector.totalBytes();
  if (total > sizeCap) {
    warnings.push(
      `Look assets total ${(total / (1024 * 1024)).toFixed(1)} MB, over the ${(
        sizeCap /
        (1024 * 1024)
      ).toFixed(0)} MB soft cap — the portable file will be large.`,
    );
  }

  return { config: out, assets: collector.list(), warnings };
}

/** Pack every entry of a URL array, keeping array order + length. */
async function packUrlArray(
  urls: string[],
  packRef: (url: string, kind: LookAssetKind) => Promise<string | null>,
): Promise<string[]> {
  const result: string[] = [];
  for (const url of urls) {
    const id = await packRef(url, 'image');
    result.push(id ?? url);
  }
  return result;
}

/**
 * Clear (with a warning per affected channel) the customer-local IndexedDB
 * `assetId`s on shaderFx GLSL channels + buffer-pass channels, in place.
 */
function dropShaderFxLocalAssetIds(
  instances: EffectInstance[] | undefined,
  warnings: string[],
): void {
  if (!instances?.length) return;
  let dropped = 0;
  const clearChannels = (channels: GuestChannel[] | undefined): void => {
    if (!channels?.length) return;
    for (const ch of channels) {
      if (ch && ch.assetId) {
        ch.assetId = undefined;
        dropped++;
      }
    }
  };

  for (const inst of instances) {
    if (!inst || inst.type !== 'shaderFx') continue;
    // GLSL guest channels (and their multipass buffer channels) carry the
    // customer-local IndexedDB assetIds. They live on the shaderFx instance's
    // `config.glsl` block (see ShaderFxInstanceConfig.glsl / GLSLGuestConfig).
    const glslBlock = inst.config?.glsl;
    if (!glslBlock) continue;
    clearChannels(glslBlock.channels);
    if (glslBlock.buffers) {
      for (const key of Object.keys(glslBlock.buffers)) {
        const buf = glslBlock.buffers[key as keyof typeof glslBlock.buffers];
        clearChannels(buf?.channels);
      }
    }
  }

  if (dropped > 0) {
    warnings.push(
      `Dropped ${dropped} GLSL channel image/cubemap asset${dropped === 1 ? '' : 's'}: local IndexedDB assets stay on the source machine.`,
    );
  }
}

/**
 * Rehydrate a packed config: replace every `look-asset:<n>` ref with the
 * matching asset's `data:` URI (or pass-through `url`). PURE and synchronous —
 * the data is already inline in the Look. Returns a rewritten CLONE. Refs with
 * no matching asset are cleared to '' (defensive: a corrupt/edited doc).
 */
export function rehydrateEffectsAssets(config: EffectsConfig, assets: LookAsset[]): EffectsConfig {
  const out = deepClone(config);
  const byId = new Map<string, LookAsset>();
  for (const a of assets) if (a && typeof a.id === 'string') byId.set(a.id, a);

  const resolveId = (ref: string | null | undefined): string | null => {
    if (!ref || typeof ref !== 'string') return null;
    if (!ref.startsWith(ASSET_ID_PREFIX)) return ref; // already a real url
    const asset = byId.get(ref);
    if (!asset) return ''; // missing → clear
    return asset.data ?? asset.url ?? '';
  };

  if (out.video?.url) {
    const v = resolveId(out.video.url);
    if (v !== null) out.video.url = v;
  }
  if (out.pixi && out.pixi.image) {
    const v = resolveId(out.pixi.image);
    if (v !== null) out.pixi.image = v;
  }
  if (out.slideshow?.items?.length) {
    for (const item of out.slideshow.items) {
      const v = resolveId(item.url);
      if (v !== null) item.url = v;
    }
  }
  const pp = out.postProcessing;
  if (pp?.oldFilm?.grainBundle?.length) {
    pp.oldFilm.grainBundle = pp.oldFilm.grainBundle.map((r) => resolveId(r) ?? r);
  }
  if (pp?.noiseOverlay?.grainBundle?.length) {
    pp.noiseOverlay.grainBundle = pp.noiseOverlay.grainBundle.map((r) => resolveId(r) ?? r);
  }

  return out;
}
