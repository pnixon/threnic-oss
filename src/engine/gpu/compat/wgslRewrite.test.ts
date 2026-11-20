import { describe, it, expect } from 'vitest';
import { rewriteWgslForWebGL2, STORAGE_ELEMENTS_PER_ROW } from './wgslRewrite';

describe('rewriteWgslForWebGL2', () => {
  it('leaves ordinary shaders untouched', () => {
    const code = `@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(tex, smp, uv); }`;
    const out = rewriteWgslForWebGL2(code);
    expect(out.code).toBe(code);
    expect(out.storage).toEqual([]);
    expect(out.aliases).toEqual([]);
  });

  it('turns external textures into 2D textures sampled at level 0', () => {
    const out = rewriteWgslForWebGL2(`@group(0) @binding(1) var video: texture_external;
@group(0) @binding(2) var smp: sampler;
fn f(uv: vec2f) -> vec4f { return textureSampleBaseClampToEdge(video, smp, fit(uv, vec2f(1.0))); }`);
    expect(out.code).toContain('var video: texture_2d<f32>;');
    expect(out.code).not.toContain('texture_external');
    expect(out.code).toContain('textureSampleLevel(video, smp, fit(uv, vec2f(1.0)), 0.0)');
  });

  it('turns a storage array of vec4 structs into a texture with an accessor', () => {
    const out = rewriteWgslForWebGL2(`struct Glyph {
  a: vec4f, // comment, with a comma
  b: vec4<f32>,
};
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
fn vs(ii: u32) -> vec4f { let g = glyphs[ii]; return g.a + glyphs[ii + 1u].b; }`);
    expect(out.storage).toEqual([{ group: 1, binding: 1, texelsPerElement: 2 }]);
    expect(out.code).toContain('@group(1) @binding(1) var glyphs_compatTex: texture_2d<f32>;');
    expect(out.code).toContain(`(i % ${STORAGE_ELEMENTS_PER_ROW}u) * 2u`);
    expect(out.code).toContain('let g = glyphs_compatAt(u32(ii));');
    expect(out.code).toContain('glyphs_compatAt(u32(ii + 1u)).b');
    expect(out.code).not.toContain('var<storage');
  });

  it('does not rewrite a storage array it cannot represent', () => {
    const code = `struct P { pos: vec3f, mass: f32 };
@group(0) @binding(0) var<storage, read> ps: array<P>;`;
    const out = rewriteWgslForWebGL2(code);
    expect(out.code).toBe(code);
    expect(out.storage).toEqual([]);
  });

  it('aliases a texture that is sampled through a second sampler', () => {
    const out = rewriteWgslForWebGL2(`@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var a: sampler;
@group(0) @binding(2) var b: sampler;
fn f(uv: vec2f) -> vec4f {
  return textureSample(tex, a, uv) + textureSampleLevel(tex, b, uv, 0.0) + textureSample(tex, a, uv * 2.0);
}`);
    expect(out.aliases).toEqual([{ group: 0, binding: 1000, sourceBinding: 0 }]);
    expect(out.code).toContain('@group(0) @binding(1000) var tex_compatS1: texture_2d<f32>;');
    expect(out.code).toContain('textureSampleLevel(tex_compatS1, b, uv, 0.0)');
    expect(out.code.match(/textureSample\(tex, a,/g)).toHaveLength(2);
  });
});
