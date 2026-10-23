/**
 * Utility functions for object manipulation and nested property access.
 */

/**
 * Get a nested property value using a dot-path string.
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj) return null;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Set a nested property on an object using a dot-path string.
 * Note: This modifies the object in-place at the final level,
 * but creates shallow copies of intermediate levels to support React-style immutability
 * if used carefully.
 *
 * Array-preserving: when an intermediate value IS an array, it is shallow-copied
 * as an array (`[...]`), not coerced to a plain object (`{...}`) — otherwise a
 * path like `channels.0.intensity` would turn the `channels` array into
 * `{0:…,1:…}` and break every `.map`/`.length`/`[i]` reader downstream. When an
 * intermediate is MISSING, it is created as an array if the next key is an
 * integer index, else as an object.
 */
export function setNestedValue(obj: object, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    const nextIsIndex = /^\d+$/.test(nextKey);
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = nextIsIndex ? [] : {};
    }
    // Shallow-copy the intermediate, preserving array-ness so numeric-index
    // paths don't clobber an array into a plain object.
    if (Array.isArray(cur[key])) {
      cur[key] = [...(cur[key] as unknown[])];
    } else if (typeof cur[key] === 'object' && cur[key] !== null) {
      cur[key] = { ...(cur[key] as object) };
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Performs a shallow equality check between two objects.
 */
export function shallowEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;
  if (!obj1 || !obj2 || typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  for (const key of keys1) {
    if ((obj1 as Record<string, unknown>)[key] !== (obj2 as Record<string, unknown>)[key]) {
      return false;
    }
  }

  return true;
}

/**
 * Performs a deep equality check between two objects.
 */
export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;
  if (!obj1 || !obj2 || typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  for (const key of keys1) {
    const val1 = (obj1 as Record<string, unknown>)[key];
    const val2 = (obj2 as Record<string, unknown>)[key];
    const areObjects = val1 && val2 && typeof val1 === 'object' && typeof val2 === 'object';
    if (areObjects ? !deepEqual(val1, val2) : val1 !== val2) {
      return false;
    }
  }

  return true;
}
