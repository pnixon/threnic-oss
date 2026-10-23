# Threnic

[![CI](https://github.com/pnixon/threnic-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/pnixon/threnic-oss/actions/workflows/ci.yml)

Threnic is a free, open source lyric video and music visualizer editor that runs
entirely in the browser. Load a track, time the lyrics, layer audio-reactive
effects, and export an MP4 — all rendered on your own GPU. Nothing is uploaded.

## Features

- Word-by-word lyric timing with JSON, LRC and SRT import
- Audio-reactive effects, post-processing and custom shaders
- MilkDrop presets, image/video backgrounds and slideshows
- Keyframes and a multi-lane timeline
- Hardware-accelerated MP4 export up to 4K at 60fps (WebCodecs)
- Projects stored locally in the browser; import and export as `.thren` files

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:3000> — the editor is served at `/` (the old `/app`
path redirects there). Node.js 20 or newer is required (see `.nvmrc`).

## Scripts

| Command              | What it does                          |
| -------------------- | ------------------------------------- |
| `npm run dev`        | Start the development server          |
| `npm run build`      | Format check and production build     |
| `npm start`          | Serve the production build            |
| `npm test`           | Run the unit tests and write a report |
| `npm run test:quick` | Run the unit tests (Vitest)           |
| `npm run test:e2e`   | Run the Playwright end-to-end tests   |
| `npm run lint`       | Run ESLint                            |
| `npm run format`     | Format the codebase with Prettier     |

## Project layout

```
src/app/          Next.js app shell (the editor renders at /)
src/components/   Editor UI: panels, stage, timeline, modals
src/engine/       Rendering, audio analysis, keyframes and export
src/stores/       Project and system state
packages/lyrics/  Framework-agnostic lyric parsing, timing and rendering
test/             Unit tests
```

## Deployment

Threnic is a self-contained Next.js app with no backend services. Run the
standalone build, or use the bundled Docker image:

```bash
docker build . -t threnic
docker run -p 3000:3000 threnic
```

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, scripts and PR expectations, and
report problems at <https://github.com/pnixon/threnic-oss/issues>.

## Browser support

Chrome and Edge are fully supported, including export. Firefox and Safari can
preview but cannot export.

## License

Released under the [MIT License](LICENSE). Third-party components keep their own
licenses; see [LEGAL/THIRD_PARTY_NOTICES.md](LEGAL/THIRD_PARTY_NOTICES.md) and
[public/fonts/README.md](public/fonts/README.md).
