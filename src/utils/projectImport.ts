/**
 * Project Import Utilities
 *
 * Handles importing Threnic projects from JSON manifests.
 */

/**
 * Scan an already-parsed project object for embedded custom shader source.
 *
 * A shared `.thren` can carry a WGSL `customShader` transform effect or a GLSL
 * guest layer whose `source` runs on the recipient's GPU. That source is
 * arbitrary user-authored code, so the importer
 * warns and asks for confirmation before loading a foreign project. Best-effort
 * structural scan: walks the object graph for a `type`/`mode` of
 * `customShader`/`glsl` or a non-empty `source`/`wgsl` string on a shader-shaped
 * node, and stops at the first hit.
 */
export function projectContainsCustomShaders(project: unknown): boolean {
  const SHADER_TYPE_MARKERS = new Set(['customshader', 'glsl']);
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): boolean {
    if (node === null || typeof node !== 'object' || depth > 12) return false;
    if (seen.has(node as object)) return false;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node) if (walk(item, depth + 1)) return true;
      return false;
    }

    const obj = node as Record<string, unknown>;

    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
    const mode = typeof obj.mode === 'string' ? obj.mode.toLowerCase() : '';
    if (SHADER_TYPE_MARKERS.has(type) || SHADER_TYPE_MARKERS.has(mode)) return true;

    for (const key of ['source', 'wgsl', 'wgslSource', 'glslSource', 'shaderSource']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) return true;
    }

    for (const value of Object.values(obj)) {
      if (walk(value, depth + 1)) return true;
    }
    return false;
  }

  return walk(project, 0);
}
