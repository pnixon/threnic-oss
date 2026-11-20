// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { rewriteWgslForWebGL2 } from './wgslRewrite';
import { loadWgslTranslator, setWgslTranslatorBinary, translateWgsl } from './wgslTranslator';

const FULLSCREEN_VS = `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO; o.pos = vec4f(p[i], 0.0, 1.0); o.uv = p[i] * 0.5 + 0.5; return o;
}`;

beforeAll(async () => {
  setWgslTranslatorBinary(readFileSync(path.join(process.cwd(), 'public/compat/wgsl-compat.wasm')));
  await loadWgslTranslator();
});

describe('translateWgsl', () => {
  it('emits GLSL ES 3.00 for both stages, with the bindings it used', () => {
    const res = translateWgsl({
      code: `${FULLSCREEN_VS}
struct U { tint: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f { return textureSample(tex, smp, i.uv) * u.tint; }`,
      vertex: 'vs',
      fragment: 'fs',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.vertex!.glsl).toContain('#version 300 es');
    // Clip space is flipped so texture row 0 is the top row, as in WebGPU.
    expect(res.vertex!.glsl).toContain('gl_Position.yz = vec2(-gl_Position.y');
    expect(res.fragment!.uniforms).toEqual([
      { group: 0, binding: 0, name: expect.stringContaining('U_block') },
    ]);
    expect(res.fragment!.textures).toEqual([
      expect.objectContaining({ group: 0, binding: 1, samplerGroup: 0, samplerBinding: 2 }),
    ]);
  });

  it('reports parse errors with a line and column', () => {
    const res = translateWgsl({ code: 'fn broken() {\n  let a = ;\n}' });
    expect(res).toMatchObject({ ok: false, stage: 'parse', line: 2 });
  });

  it('reports a missing entry point instead of throwing', () => {
    const res = translateWgsl({ code: FULLSCREEN_VS, vertex: 'nope' });
    expect(res).toMatchObject({ ok: false, stage: 'vertex' });
  });

  it('keeps working after rejecting a module', () => {
    translateWgsl({ code: 'this is not wgsl' });
    expect(translateWgsl({ code: FULLSCREEN_VS, vertex: 'vs' }).ok).toBe(true);
  });

  it('translates a storage array once it has been rewritten', () => {
    const { code, storage } = rewriteWgslForWebGL2(`
struct Item { rect: vec4f, color: vec4f };
@group(0) @binding(0) var<storage, read> items: array<Item>;
struct VO { @builtin(position) pos: vec4f, @location(0) c: vec4f }
@vertex fn vs(@builtin(instance_index) ii: u32) -> VO {
  var o: VO; o.pos = items[ii].rect; o.c = items[ii].color; return o;
}`);
    expect(storage).toHaveLength(1);
    const res = translateWgsl({ code, vertex: 'vs' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.vertex!.glsl).toContain('texelFetch');
    expect(res.vertex!.firstInstance).toBe(true);
    expect(res.vertex!.textures).toEqual([
      expect.objectContaining({ group: 0, binding: 0, samplerGroup: null }),
    ]);
  });

  it('translates a texture sampled through two samplers once it has been rewritten', () => {
    const { code, aliases } = rewriteWgslForWebGL2(`${FULLSCREEN_VS}
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var a: sampler;
@group(0) @binding(2) var b: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  return textureSample(tex, a, i.uv) + textureSample(tex, b, i.uv);
}`);
    expect(aliases).toHaveLength(1);
    const res = translateWgsl({ code, fragment: 'fs' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fragment!.textures).toHaveLength(2);
  });
});
