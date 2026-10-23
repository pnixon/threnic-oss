# THIRD-PARTY NOTICES

Threnic incorporates third-party open-source code. This file lists that code,
its author, and its license. Each entry's license text governs that portion of
the codebase; Threnic's own code is released under the MIT License (see the root
`LICENSE`).

Shader source authored or pasted by users through the in-app custom-shader
editor is **not** covered by this file — it is the user's own content and the
responsibility of the person who supplied it.

---

## Shader hash functions — Dave Hoskins

Hash-without-sine functions (`hash11`, `hash21`, `hash22`, and the `0.1031`
constant family) used in the shared WGSL shader prelude and several overlay
presets.

- **Author:** Dave Hoskins
- **Source:** "Hash without Sine" — https://www.shadertoy.com/view/4djSRW
- **License:** MIT
- **Used in:** `src/engine/gpu/shaderPresets/prelude.wgsl.ts` (and presets that
  reference its accessors)

```
The MIT License (MIT)
Copyright (c) 2014 David Hoskins

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3D Simplex Noise — Ian McEwan, Ashima Arts

Simplex noise (`snoise`, `mod289`, `permute`, `taylorInvSqrt`) used in the
atmosphere particle shaders.

- **Authors:** Ian McEwan, Ashima Arts
- **Source:** https://github.com/ashima/webgl-noise
- **License:** MIT
- **Used in:** `src/components/atmosphere/shaders/noise.glsl`

```
Copyright (C) 2011 Ashima Arts. All rights reserved.
Copyright (C) 2011 Stefan Gustavson. All rights reserved.
Distributed under the MIT License. See LICENSE file.
https://github.com/ashima/webgl-noise
https://github.com/stegu/webgl-noise

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## Bundled npm dependencies

Threnic's browser bundle and its server-side render/tooling include
open-source npm packages. A browser bundle is a distribution, so the MIT,
BSD, ISC, and Apache-2.0 notices below accompany the shipped product.

As of the audit for v0.11.0 the production dependency tree contained **269 packages**, by declared license:

| License                          | Packages | Notes                                                        |
| -------------------------------- | -------- | ------------------------------------------------------------ |
| MIT                              | 206      | Notice must accompany distribution                           |
| Apache-2.0                       | 18       | Notice + NOTICE-file terms                                   |
| ISC                              | 16       | Functionally equivalent to MIT                               |
| BSD-3-Clause                     | 17       | Includes the `protobufjs` family                             |
| BlueOak-1.0.0                    | 3        |                                                              |
| CC-BY-4.0                        | 1        | `caniuse-lite` — **attribution required**                    |
| MPL-2.0                          | 1        | File-level copyleft; used unmodified                         |
| Zlib                             | 1        |                                                              |
| 0BSD                             | 1        | No attribution required                                      |
| MIT OR CC0-1.0                   | 1        | `type-fest` — Threnic elects MIT                             |
| MIT\*                            | 1        | `webgl-constants` — MIT stated, license file absent upstream |
| Apache-2.0 AND LGPL-3.0-or-later | 2        | `@img/sharp` / libvips — see below                           |
| MIT                              | 1        | `threnic` itself (this repo — see root `LICENSE`)            |

### Attribution-required components (called out explicitly)

- **caniuse-lite** (CC-BY-4.0) — browser-support data, © the caniuse
  contributors. Distributed under Creative Commons Attribution 4.0.
  Source: https://github.com/browserslist/caniuse-lite
- **webgl-constants** (MIT, license text not published upstream) — WebGL
  enum constants. Source: https://github.com/kdashg/webgl-constants
- **@img/sharp** / **sharp** (Apache-2.0; bundles libvips under LGPL-3.0) —
  server-side image processing. libvips is dynamically linked as a prebuilt
  binary and is not modified. LGPL-3.0 compliance is satisfied by dynamic
  linking + this notice. Source: https://github.com/lovell/sharp
- **type-fest** (MIT OR CC0-1.0) — Threnic elects the MIT option.

### Regenerating the license summary

The counts above are a point-in-time snapshot. To list the licenses of the
current production dependency tree, run:

```
npx license-checker --production --summary
```

Update this file whenever production dependencies change. The in-app **About**
screen links here.

---

## Bundled fonts

Threnic redistributes 16 font families (16 files) under `public/fonts/`, all
under **CC0 1.0**, the **MIT License**, or the **Apache License 2.0** only (no
OFL-licensed fonts are bundled). Per-family sources, licenses, and the
by-video-type catalog are documented in
[`public/fonts/README.md`](../public/fonts/README.md) alongside the full
`LICENSE-CC0-1.0.txt`, `LICENSE-MIT.txt`, and `LICENSE-Apache-2.0.txt` texts.
Apache-2.0: Roboto Slab (© Google LLC). MIT: Comic Mono (© 2020 dtinth),
ProggyVector (© 2004–2005 Tristan Grimmer). CC0 (github.com/ggbotnet/fonts-cc0):
Type Light Sans, Skyte, O Serif, Secoline, Jupiteroid, Public Pixel, Home Video,
MatrixType, Rainbow 2000, Operation Napalm, Novem, Crayon Libre, 3x3 Mono.

---

## Music visualizer presets — butterchurn / MilkDrop

Threnic's music-visualizer mode renders **MilkDrop presets** through the
MIT-licensed [`butterchurn`](https://github.com/jberg/butterchurn) engine and
the [`butterchurn-presets`](https://github.com/jberg/butterchurn-presets)
package (both © Jordan Berg, MIT).

- **Author:** Jordan Berg
- **Sources:** https://github.com/jberg/butterchurn and
  https://github.com/jberg/butterchurn-presets
- **License:** MIT (both packages ship the identical license text below)
- **Used in:** `src/engine/gpu/butterchurn/ButterchurnRenderer.ts`,
  `src/components/effects/shared/ButterchurnPresetSelect.tsx`

```
MIT License

Copyright (c) 2013-2018 Jordan Berg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The MIT license covers the JavaScript engine and packaging. The **preset
content itself** is a large community corpus of `.milk` files written between
roughly 2001 and 2012 by MilkDrop authors including **Geiss, Rovastar, Flexi,
Martin, Unchained, EoS, Phat** and many others. These presets were authored
without formal license terms; the packager's MIT relicensing does not
represent a grant from each original author.

- Preset names shown in the in-app picker generally carry the author's handle
  (e.g. `Rovastar - ...`, `Flexi - ...`), so the author is credited at the
  point of use.
- Threnic also ships its own independent, "inspired-by" MilkDrop-style presets
  in `src/engine/gpu/milkdrop/presets.ts`; those are Threnic-authored.
- If you authored one of these presets and want it credited differently or
  removed, please open an issue at https://github.com/pnixon/threnic-oss/issues.
- **MilkDrop** and **Winamp** are third-party marks (Nullsoft / Llama Group).
  Threnic uses "MilkDrop" only descriptively, to name the preset format it
  reads; the feature itself is not branded with either mark.

---

## Media assets

The bundled media under `public/` (game-scene art, film-grain textures and the
Threnic logo) are Threnic originals, generated procedurally in-engine or with AI
image tools.
