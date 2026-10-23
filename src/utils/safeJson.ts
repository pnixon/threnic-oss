/**
 * Utility for safe JSON handling and circular reference detection.
 * Designed to prevent "Converting circular structure to JSON" errors.
 */

/**
 * A JSON.stringify replacer function that handles circular references.
 * It replaces circular references with a string "[Circular]".
 */
export function safeReplacer(): (_key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return function (_key: string, value: unknown): unknown {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

/**
 * Safely stringifies an object, handling circular references.
 * If serialization fails, it falls back to a safe representation.
 *
 * @param obj The object to stringify
 * @param indent Number of spaces for indentation
 */
export function safeStringify(obj: unknown, indent: number = 2): string {
  try {
    return JSON.stringify(obj, safeReplacer(), indent);
  } catch (e) {
    console.warn('safeStringify failed even with replacer:', e);
    return String(obj);
  }
}
