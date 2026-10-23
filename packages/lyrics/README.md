# @threnic/lyrics

Framework-agnostic lyric **timing, parsing, Canvas2D rendering, and timing
diagnostics** — extracted from the Threnic engine. No React, no Three.js, no
WebGPU, no app stores. Runs in the browser main thread, in a Web Worker
(OffscreenCanvas), and — for the pure logic — in Node.

## Layers

| Layer         | Exports                                                                                                                                                                                                                                     | Notes                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `types`       | `Word`, `LyricLineData`, `LyricTheme`, `LineStyleOverride`, `ThrenicWord`, `ThrenicTrack`, `TrackTitleConfig`, `DEFAULT_LYRICS_THEME`                                                                                                       | The data contract.                            |
| `core`        | `calculateWordAnimation` & easing, `LyricParsers` (LRC/SRT/text), `parseJson`/`parseLyrics`/`loadLyricsFrom*`, `lyricLinesToThrenicWords`/`threnicWordsToLyricLines`/`autoAssignLanes`/`reconcileWordTimings`, `ui<->engine` animation maps | Pure logic; Node-testable.                    |
| `render`      | `CanvasLyricRenderer`, `FontRegistry`/`createFontRegistry`                                                                                                                                                                                  | Canvas2D → transparent bitmap for GPU upload. |
| `diagnostics` | `validateTiming` → `TimingReport`                                                                                                                                                                                                           | Lints timing data.                            |

## Rendering

```ts
import { CanvasLyricRenderer, createFontRegistry, DEFAULT_LYRICS_THEME } from '@threnic/lyrics';

const renderer = new CanvasLyricRenderer(
  { lyrics, theme: DEFAULT_LYRICS_THEME },
  { fontRegistry: createFontRegistry(MY_FONTS) }, // optional — see Seams
);

// Per frame: returns an HTMLCanvasElement | OffscreenCanvas | null (transparent RGBA)
const bitmap = renderer.render(timeSeconds, widthPx, heightPx, audioMetrics);
```

The returned canvas is transparent; the caller composites it (Threnic uploads it
to a `GPUTexture` and alpha-blends via its `LyricCompositePass`). `render()`
returns `null` when there is nothing visible at that time.

## Diagnostics

```ts
import { validateTiming } from '@threnic/lyrics';

const report = validateTiming(lines, { largeGapThreshold: 10 });
if (!report.ok) console.table(report.issues);
```

Flags: negative/zero line & word durations, out-of-order words, words outside
their line bounds, overlapping lines in the same lane, empty lines, and large
silent gaps (info). `report.ok` is true when there are zero `error`-severity
issues.

## Injected seams

Two things the in-app original hardcoded are **injected** here so the package
carries no app coupling:

1. **Fonts** — the renderer resolves per-lane `fontId` overrides through a
   `FontRegistry` passed to the constructor. Build one from your own font table
   with `createFontRegistry(fonts)`. If omitted, per-lane `fontId` overrides
   fall back to the global font and everything else renders normally. The global
   font is still set via `config.fontUrl` / `theme.fontUrl` (a URL), unchanged.
2. **TrackTitleConfig** — a minimal package-local type covering only the fields
   the renderer reads; the Threnic app's larger config is structurally
   compatible.

## Build & test

```bash
npm run build      # tsup → dist/{index.js,index.cjs,index.d.ts}
npm test           # vitest (happy-dom)
npm run typecheck  # tsc --noEmit
```

## License

MIT
