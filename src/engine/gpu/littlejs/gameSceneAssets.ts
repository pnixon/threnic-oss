/**
 * Game Scene Asset Storage — persists user-uploaded sprites in IndexedDB.
 *
 * Keys: `gameScene.<sceneId>.<slot>` where slot is 'left' | 'right' | 'background'
 * Values: Blob objects (image data)
 *
 * Returns blob URLs for immediate use. Defaults fall back to /assets/game-scenes/ static files.
 */

import { getDB } from '@/utils/indexedDB';

export type GameSceneSlot = 'left' | 'right' | 'background';

const DEFAULTS: Record<string, Record<GameSceneSlot, string>> = {
  rpgCombat: {
    left: '/assets/game-scenes/hero.png',
    right: '/assets/game-scenes/hydra.png',
    background: '/assets/game-scenes/background.jpg',
  },
};

/** Get the IDB key for a scene asset slot. */
function idbKey(sceneId: string, slot: GameSceneSlot): string {
  return `gameScene.${sceneId}.${slot}`;
}

/**
 * Save a user-uploaded image blob for a game scene slot.
 */
export async function saveGameSceneAsset(
  sceneId: string,
  slot: GameSceneSlot,
  blob: Blob,
): Promise<string> {
  const db = await getDB();
  await db.put('settings', blob, idbKey(sceneId, slot));
  return URL.createObjectURL(blob);
}

/**
 * Load a game scene asset from IDB. Returns a blob URL if custom asset exists,
 * or the default static URL if not.
 */
export async function loadGameSceneAsset(sceneId: string, slot: GameSceneSlot): Promise<string> {
  try {
    const db = await getDB();
    const blob = await db.get('settings', idbKey(sceneId, slot));
    if (blob instanceof Blob) {
      return URL.createObjectURL(blob);
    }
  } catch {
    // Fall through to default
  }
  return getDefaultAssetUrl(sceneId, slot);
}

/**
 * Load ONLY a custom (user-uploaded) asset for a slot. Unlike
 * loadGameSceneAsset, this does NOT fall back to the bundled default — it
 * returns `undefined` when the user has not supplied one. Used for the
 * background slot, where "no custom asset" means "no backdrop" (transparent
 * overlay) rather than "use the built-in forest".
 */
export async function loadCustomGameSceneAsset(
  sceneId: string,
  slot: GameSceneSlot,
): Promise<string | undefined> {
  try {
    const db = await getDB();
    const blob = await db.get('settings', idbKey(sceneId, slot));
    if (blob instanceof Blob) {
      return URL.createObjectURL(blob);
    }
  } catch {
    // Fall through to undefined
  }
  return undefined;
}

/**
 * Load all game scene assets. Left and right fighters fall back to their
 * bundled
 * defaults (the characters must always render), but the BACKGROUND does not:
 * when the user has removed / not supplied a custom background, this returns
 * `undefined` for it. The scene treats a missing background as "no backdrop"
 * and stays transparent there so Threnic's real background shows through.
 */
export async function loadAllGameSceneAssets(
  sceneId: string,
): Promise<{ left: string; right: string; background?: string }> {
  const [left, right, background] = await Promise.all([
    loadGameSceneAsset(sceneId, 'left'),
    loadGameSceneAsset(sceneId, 'right'),
    loadCustomGameSceneAsset(sceneId, 'background'),
  ]);
  return { left, right, background };
}

/**
 * Remove a custom asset (reverts to default).
 */
export async function removeGameSceneAsset(sceneId: string, slot: GameSceneSlot): Promise<void> {
  const db = await getDB();
  await db.delete('settings', idbKey(sceneId, slot));
}

/**
 * Check if a custom asset exists for a slot.
 */
export async function hasCustomGameSceneAsset(
  sceneId: string,
  slot: GameSceneSlot,
): Promise<boolean> {
  try {
    const db = await getDB();
    const blob = await db.get('settings', idbKey(sceneId, slot));
    return blob instanceof Blob;
  } catch {
    return false;
  }
}

/**
 * Get the default (built-in) asset URL for a scene slot.
 */
export function getDefaultAssetUrl(sceneId: string, slot: GameSceneSlot): string {
  return DEFAULTS[sceneId]?.[slot] ?? `/assets/game-scenes/${slot}.png`;
}
