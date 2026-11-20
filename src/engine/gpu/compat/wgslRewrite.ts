/**
 * Source-level WGSL rewrites applied before translation to GLSL ES 3.00.
 *
 * WebGL2 has neither external (video) textures nor storage buffers, and the
 * translator cannot emit either. Both are used sparingly in Threnic, in forms
 * regular enough to rewrite at the source level:
 *
 *  - `texture_external` becomes an ordinary `texture_2d<f32>` that the backend
 *    fills from the video frame, and `textureSampleBaseClampToEdge` becomes a
 *    level-0 sample of it.
 *  - a read-only storage array of a struct made only of `vec4f` members becomes
 *    a float texture holding one texel per member, read back through a
 *    generated accessor function.
 */

/** A storage array that was rewritten to a float texture. */
export interface StorageTextureBinding {
  group: number;
  binding: number;
  /** vec4 texels per array element. */
  texelsPerElement: number;
}

/** An extra binding that stands for an existing texture (see rewriteSharedTextures). */
export interface TextureAlias {
  group: number;
  /** Synthetic binding number, outside the range real bindings use. */
  binding: number;
  /** The binding of the texture it duplicates. */
  sourceBinding: number;
}

export interface RewrittenWgsl {
  code: string;
  storage: StorageTextureBinding[];
  aliases: TextureAlias[];
}

/** First synthetic binding number handed out for texture aliases. */
const ALIAS_BINDING_BASE = 1000;

/** Array elements laid out per texture row; rows hold whole elements. */
export const STORAGE_ELEMENTS_PER_ROW = 128;

/** Index of the bracket/paren closing the one opened at `open`. */
function matchClose(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function rewriteExternalTextures(src: string): string {
  if (!src.includes('texture_external') && !src.includes('textureSampleBaseClampToEdge')) {
    return src;
  }
  let out = src.replace(/\btexture_external\b/g, 'texture_2d<f32>');
  const call = 'textureSampleBaseClampToEdge';
  let from = 0;
  for (;;) {
    const at = out.indexOf(call, from);
    if (at < 0) break;
    const open = out.indexOf('(', at);
    const close = open < 0 ? -1 : matchClose(out, open, '(', ')');
    if (close < 0) break;
    out =
      out.slice(0, at) + 'textureSampleLevel' + out.slice(open, close) + ', 0.0' + out.slice(close);
    from = at + 1;
  }
  return out;
}

const STORAGE_DECL =
  /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var\s*<\s*storage(?:\s*,\s*read)?\s*>\s*(\w+)\s*:\s*array\s*<\s*(\w+)\s*>\s*;/;

/** Field count of `struct name { ... }` if every member is a vec4 of f32. */
function vec4FieldCount(src: string, name: string): number | null {
  const m = new RegExp(`struct\\s+${name}\\s*\\{`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchClose(src, open, '{', '}');
  if (close < 0) return null;
  const body = src
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fields = body
    .split(/[,;]/)
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length === 0) return null;
  for (const f of fields) {
    if (!/^\w+\s*:\s*(vec4f|vec4\s*<\s*f32\s*>)$/.test(f)) return null;
  }
  return fields.length;
}

function rewriteStorageArrays(src: string, storage: StorageTextureBinding[]): string {
  let out = src;
  for (;;) {
    const m = STORAGE_DECL.exec(out);
    if (!m) return out;
    const [decl, group, binding, name, type] = m;
    const count = vec4FieldCount(out, type);
    if (count === null) {
      // Leave it: the translator reports storage buffers as unsupported.
      return out;
    }
    const tex = `${name}_compatTex`;
    const fn = `${name}_compatAt`;
    const loads: string[] = [];
    for (let k = 0; k < count; k++) {
      loads.push(`textureLoad(${tex}, vec2u(x + ${k}u, y), 0)`);
    }
    const replacement =
      `@group(${group}) @binding(${binding}) var ${tex}: texture_2d<f32>;\n` +
      `fn ${fn}(i: u32) -> ${type} {\n` +
      `  let x = (i % ${STORAGE_ELEMENTS_PER_ROW}u) * ${count}u;\n` +
      `  let y = i / ${STORAGE_ELEMENTS_PER_ROW}u;\n` +
      `  return ${type}(${loads.join(', ')});\n` +
      `}\n`;
    const before = out.slice(0, m.index);
    let after = out.slice(m.index + decl.length);
    // name[expr] → accessor(expr), in the code that follows the declaration.
    const use = new RegExp(`\\b${name}\\s*\\[`);
    for (;;) {
      const u = use.exec(after);
      if (!u) break;
      const open = u.index + u[0].length - 1;
      const close = matchClose(after, open, '[', ']');
      if (close < 0) break;
      after =
        after.slice(0, u.index) +
        `${fn}(u32(${after.slice(open + 1, close)}))` +
        after.slice(close + 1);
    }
    out = before + replacement + after;
    storage.push({ group: Number(group), binding: Number(binding), texelsPerElement: count });
  }
}

const TEXTURE_DECL =
  /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var\s+(\w+)\s*:\s*(texture_2d\s*<\s*f32\s*>)\s*;/g;
const SAMPLER_DECL = /\bvar\s+(\w+)\s*:\s*sampler\s*;/g;
const SAMPLE_CALL = /\b(textureSample(?:Level|Bias|Grad)?\s*\(\s*)(\w+)(\s*,\s*)(\w+)\b/g;

/**
 * GLSL has combined texture+sampler uniforms, and the translator cannot emit
 * one texture paired with two different samplers. Where a shader does that,
 * give every sampler after the first its own alias of the texture; the
 * backend binds the same texture to each alias.
 */
function rewriteSharedTextures(src: string, aliases: TextureAlias[]): string {
  const textures = new Map<string, { group: number; binding: number; end: number }>();
  for (const m of src.matchAll(TEXTURE_DECL)) {
    textures.set(m[3], {
      group: Number(m[1]),
      binding: Number(m[2]),
      end: m.index! + m[0].length,
    });
  }
  if (textures.size === 0) return src;
  const samplers = new Set<string>();
  for (const m of src.matchAll(SAMPLER_DECL)) samplers.add(m[1]);

  // texture name → samplers it is used with, in order of first use.
  const pairs = new Map<string, string[]>();
  for (const m of src.matchAll(SAMPLE_CALL)) {
    if (!textures.has(m[2]) || !samplers.has(m[4])) continue;
    const list = pairs.get(m[2]) ?? [];
    if (!list.includes(m[4])) list.push(m[4]);
    pairs.set(m[2], list);
  }
  if (![...pairs.values()].some((l) => l.length > 1)) return src;

  const aliasName = (tex: string, k: number) => `${tex}_compatS${k}`;
  let out = src.replace(SAMPLE_CALL, (all, head: string, tex: string, sep: string, smp: string) => {
    const k = pairs.get(tex)?.indexOf(smp) ?? -1;
    return k > 0 ? `${head}${aliasName(tex, k)}${sep}${smp}` : all;
  });
  // Declarations go in from the end of the file backwards so offsets stay valid.
  const decls = [...pairs.entries()]
    .filter(([, l]) => l.length > 1)
    .map(([tex, l]) => ({ tex, count: l.length, ...textures.get(tex)! }))
    .sort((a, b) => b.end - a.end);
  for (const d of decls) {
    let text = '';
    for (let k = 1; k < d.count; k++) {
      const binding = ALIAS_BINDING_BASE + aliases.length;
      aliases.push({ group: d.group, binding, sourceBinding: d.binding });
      text += `\n@group(${d.group}) @binding(${binding}) var ${aliasName(d.tex, k)}: texture_2d<f32>;`;
    }
    out = out.slice(0, d.end) + text + out.slice(d.end);
  }
  return out;
}

/** Apply every compatibility rewrite to a WGSL module. */
export function rewriteWgslForWebGL2(code: string): RewrittenWgsl {
  const storage: StorageTextureBinding[] = [];
  const aliases: TextureAlias[] = [];
  const withTextures = rewriteExternalTextures(code);
  const withStorage = rewriteStorageArrays(withTextures, storage);
  return { code: rewriteSharedTextures(withStorage, aliases), storage, aliases };
}
