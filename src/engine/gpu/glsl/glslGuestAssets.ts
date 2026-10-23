/**
 * GLSL Guest Asset Storage — persists customer-uploaded iChannel images and
 * cubemap faces in IndexedDB, LOCALLY on the customer's machine.
 *
 * Hard rule (see Threnic asset-storage policy): customer-provided assets bound
 * to GLSL iChannel textures are never uploaded anywhere.
 * So these blobs live only in the browser's IndexedDB, keyed by the guest
 * instance id and the channel slot.
 *
 * Keys: `glslGuest.<guestId>.<slot>` where slot is:
 *   - `ch<N>`            for a 2D image on iChannelN (N = 0..3)
 *   - `ch<N>.face<F>`    for cubemap face F (0..5) on iChannelN
 * Values: raw Blob (image data). Following the gameSceneAssets pattern, the
 * blob URL is NEVER persisted — a fresh `URL.createObjectURL` is minted on every
 * load, so the stale-`blob:`-after-reload class of bug is structurally avoided.
 *
 * Cubemap face order matches WebGL TEXTURE_CUBE_MAP_POSITIVE_X..NEGATIVE_Z:
 *   0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z
 */

import { getDB } from '@/utils/indexedDB';

/** IndexedDB store used (shared generic settings store, value: Blob). */
const STORE = 'settings' as const;

/** Number of cubemap faces. */
export const CUBEMAP_FACE_COUNT = 6;

/** Human labels for the six cubemap faces, in GL face order. */
export const CUBEMAP_FACE_LABELS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;

/** The asset slot discriminator for a 2D image channel. */
export function image2dSlot(channel: number): string {
  return `ch${channel}`;
}

/** The asset slot discriminator for one cubemap face of a channel. */
export function cubemapFaceSlot(channel: number, face: number): string {
  return `ch${channel}.face${face}`;
}

/** The asset slot discriminator for a channel's uploaded video. */
export function videoSlot(channel: number): string {
  return `ch${channel}.video`;
}

/** Full IndexedDB key for a guest asset slot. */
function idbKey(guestId: string, slot: string): string {
  return `glslGuest.${guestId}.${slot}`;
}

/** Save a customer-uploaded image blob for a guest asset slot. Returns a fresh blob URL. */
export async function saveGuestAsset(guestId: string, slot: string, blob: Blob): Promise<string> {
  const db = await getDB();
  await db.put(STORE, blob, idbKey(guestId, slot));
  return URL.createObjectURL(blob);
}

/** Load the raw blob for a guest asset slot, or undefined if absent. */
export async function loadGuestAssetBlob(guestId: string, slot: string): Promise<Blob | undefined> {
  try {
    const db = await getDB();
    const blob = await db.get(STORE, idbKey(guestId, slot));
    return blob instanceof Blob ? blob : undefined;
  } catch {
    return undefined;
  }
}

/** Load a guest asset as a fresh blob URL (minted per call), or undefined. */
export async function loadGuestAssetUrl(
  guestId: string,
  slot: string,
): Promise<string | undefined> {
  const blob = await loadGuestAssetBlob(guestId, slot);
  return blob ? URL.createObjectURL(blob) : undefined;
}

/** Remove one guest asset slot. */
export async function removeGuestAsset(guestId: string, slot: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORE, idbKey(guestId, slot));
  } catch {
    // best-effort
  }
}

/**
 * Decode a stored blob to an ImageBitmap for texture upload. Returns null on
 * failure (missing/corrupt). `vflip` applies the standard vertical flip at
 * decode time so the renderer needn't flip per frame.
 */
export async function decodeGuestBitmap(
  blob: Blob | undefined,
  vflip: boolean,
): Promise<ImageBitmap | null> {
  if (!blob) return null;
  if (typeof createImageBitmap === 'undefined') return null;
  try {
    return await createImageBitmap(blob, {
      imageOrientation: vflip ? 'flipY' : 'none',
      premultiplyAlpha: 'none',
    });
  } catch {
    return null;
  }
}

/**
 * Load + decode a 2D image channel's bitmap for a guest, or null when unbound
 * or missing.
 */
export async function loadGuestImage2D(
  guestId: string,
  channel: number,
  vflip: boolean,
): Promise<ImageBitmap | null> {
  const blob = await loadGuestAssetBlob(guestId, image2dSlot(channel));
  return decodeGuestBitmap(blob, vflip);
}

/**
 * Load + decode all six cubemap faces for a channel. Returns an array of length
 * 6; any missing/failed face is null (caller decides how to handle a partial
 * cube — typically skip binding it).
 */
export async function loadGuestCubemap(
  guestId: string,
  channel: number,
  vflip: boolean,
): Promise<(ImageBitmap | null)[]> {
  const faces = await Promise.all(
    Array.from({ length: CUBEMAP_FACE_COUNT }, (_, f) =>
      loadGuestAssetBlob(guestId, cubemapFaceSlot(channel, f)),
    ),
  );
  return Promise.all(faces.map((b) => decodeGuestBitmap(b, vflip)));
}
