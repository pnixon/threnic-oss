# Contributing to Threnic

Thanks for helping out! Bug reports, ideas and pull requests are all welcome.
Please open an [issue](https://github.com/pnixon/threnic-oss/issues) before
starting on anything large so we can agree on the approach.

## Setup

Requires Node.js 20 or newer (see `.nvmrc`).

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. `npm install` also sets up a Husky
pre-commit hook that formats staged files with Prettier (and runs a
[gitleaks](https://github.com/gitleaks/gitleaks) secret scan if it's installed).

## Useful scripts

| Command                 | What it does                                 |
| ----------------------- | -------------------------------------------- |
| `npm run dev`           | Development server                           |
| `npm run lint`          | ESLint                                       |
| `npm run format`        | Format everything with Prettier              |
| `npm run check-format`  | Check formatting without writing             |
| `npm run test:quick`    | Unit tests (Vitest)                          |
| `npm test`              | Unit tests plus a `test-results.md` report   |
| `npm run test:e2e`      | Playwright end-to-end tests (`src/test/e2e`) |
| `npm run build`         | Format check and production build            |
| `npm run docker:verify` | Build the Docker image and check it starts   |

## Tests

- Unit tests live in `test/` and next to the code as `*.test.ts(x)`; run them
  with `npx vitest run`.
- End-to-end tests live in `src/test/e2e` and need Chromium installed
  (`npx playwright install chromium`).
- Add or update tests for behavior you change.

## Code style

Formatting is handled by Prettier and linting by ESLint — run `npm run format`
and `npm run lint` before pushing. Use TypeScript, keep changes focused, and
prefer `console.warn`/`console.error` for genuine diagnostics over
`console.log`.

## Pull requests

- Keep each PR to one logical change and describe what and why.
- Make sure CI passes: lint, format check, type check, unit tests and build.
- Include screenshots or a short clip for visual changes.
- By contributing you agree your work is released under the
  [MIT License](LICENSE).
