/**
 * Effect Image Asset Storage — persists per-effect user-uploaded images in
 * IndexedDB.
 *
 * Keys: `effectImage.<assetId>` where assetId is a unique id minted per upload
 * Values: Blob objects (image data)
 *
 * Mirrors the pattern of gameSceneAssets.ts (getDB + db.put/get/delete on the
 * 'settings' store), but keyed per opaque asset id rather than per scene slot.
 */

import { getDB } from '@/utils/indexedDB';

/** Get the IDB key for an effect image asset. */
function idbKey(assetId: string): string {
  return `effectImage.${assetId}`;
}

/** Mint a new unique asset id for an effect image upload. */
export function newEffectImageAssetId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `effectimg-${uuid}`;
}

/** Save a user-uploaded image blob under the given asset id. */
export async function saveEffectImageAsset(assetId: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put('settings', blob, idbKey(assetId));
}

/**
 * Load an effect image blob by asset id. Returns `undefined` when no blob is
 * stored (or on error) rather than throwing.
 */
export async function loadEffectImageBlob(assetId: string): Promise<Blob | undefined> {
  try {
    const db = await getDB();
    const blob = await db.get('settings', idbKey(assetId));
    if (blob instanceof Blob) {
      return blob;
    }
  } catch {
    // Fall through to undefined
  }
  return undefined;
}

/** Remove a stored effect image asset. */
export async function removeEffectImageAsset(assetId: string): Promise<void> {
  const db = await getDB();
  await db.delete('settings', idbKey(assetId));
}
