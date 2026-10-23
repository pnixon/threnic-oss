# Bundled Fonts — Licenses & Attribution

Threnic redistributes the font files in this directory (`public/fonts/`) and
embeds them in rendered/exported video. **Every bundled font is released under
CC0 1.0, the MIT License, or the Apache License 2.0** — permissive licenses that
allow embedding, redistribution, modification, and commercial use. **No OFL fonts
are bundled** (OFL's reserved-font-name and bundled-license obligations are
avoided by policy). Note: nearly all of Google Fonts is now OFL — only a small
subset (e.g. Roboto Slab) remains Apache-2.0.

License texts accompanying this file:

- `LICENSE-CC0-1.0.txt` — Creative Commons CC0 1.0 Universal
- `LICENSE-MIT.txt` — the MIT License (per-font copyright holders below)
- `LICENSE-Apache-2.0.txt` — Apache License 2.0 (Roboto Slab)

## Font families, by video type

### Clean / modern (sans)
| Family | File | License | Source |
| --- | --- | --- | --- |
| Type Light Sans | `TypeLightSans-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Skyte | `Skyte-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

### Cinematic / elegant (serif)
| Family | File | License | Source |
| --- | --- | --- | --- |
| Roboto Slab | `RobotoSlab-Variable.ttf` | Apache-2.0 | © Google LLC — github.com/google/fonts/apache/robotoslab |
| O Serif | `OSerif-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Secoline | `Secoline-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

### Retro / synthwave / sci-fi (display)
| Family | File | License | Source |
| --- | --- | --- | --- |
| Jupiteroid | `Jupiteroid-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Public Pixel | `PublicPixel-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Home Video | `HomeVideo-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| MatrixType | `MatrixType-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Rainbow 2000 | `Rainbow2000-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

### Bold impact / street
| Family | File | License | Source |
| --- | --- | --- | --- |
| Operation Napalm | `OperationNapalm-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |
| Novem | `Novem-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

### Lo-fi / handwritten
| Family | File | License | Source |
| --- | --- | --- | --- |
| Crayon Libre | `CrayonLibre-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

### Coder / monospace
| Family | File | License | Source |
| --- | --- | --- | --- |
| Comic Mono | `ComicMono-Regular.ttf` | MIT | © 2020 dtinth — github.com/dtinth/comic-mono-font |
| ProggyVector | `ProggyVector-Regular.ttf` | MIT | © 2004–2005 Tristan Grimmer — github.com/bluescan/proggyfonts |
| 3x3 Mono | `3x3Mono-Regular.ttf` | CC0 | github.com/ggbotnet/fonts-cc0 |

## Notes

- **Licensing policy:** bundled fonts are restricted to CC0, MIT, or Apache-2.0.
  Before adding a font, verify its license is one of these from the source repo's
  `LICENSE` file (for Google Fonts, confirm it lives under `apache/` not `ofl/` in
  github.com/google/fonts) and add it to `src/constants/fonts.ts`.
- **CC0** requires no attribution (source column above is courtesy). **MIT**
  requires the copyright + permission notice accompany the software
  (`LICENSE-MIT.txt` + the holders above). **Apache-2.0** requires the license be
  retained and significant modifications noted; the fonts here are shipped
  unmodified. All three permit embedding in exported/commercial video.
- Legacy `fontId` values from saved projects (e.g. `roboto`) are remapped to a
  current font by `resolveFontId()` in `src/constants/fonts.ts`.
- Cross-referenced from `LEGAL/THIRD_PARTY_NOTICES.md`.
