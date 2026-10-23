/**
 * Test runner that outputs results to both CLI and a markdown file.
 * Usage: node scripts/test-report.mjs [vitest args...]
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2).join(' ');
const reportPath = resolve(process.cwd(), 'test-results.md');

let jsonOutput;
try {
  // Run vitest with JSON reporter to capture structured output
  jsonOutput = execSync(`npx vitest run --reporter=json ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (err) {
  // vitest exits non-zero on test failures — that's expected
  jsonOutput = err.stdout || '';
}

let results;
try {
  results = JSON.parse(jsonOutput);
} catch {
  console.error('Failed to parse vitest JSON output.');
  console.error('Raw output (first 500 chars):', jsonOutput?.slice(0, 500));
  process.exit(1);
}

// ── Build markdown report ──────────────────────────────────────────────
const lines = [];
const passed = results.numPassedTests || 0;
const failed = results.numFailedTests || 0;
const total = results.numTotalTests || 0;
const skipped = total - passed - failed;
const duration = (
  (results.testResults || []).reduce((s, r) => s + (r.endTime - r.startTime), 0) / 1000
).toFixed(2);

lines.push(`# Test Results`);
lines.push('');
lines.push(`> Run at: ${new Date().toLocaleString()}`);
lines.push('');

if (failed === 0) {
  lines.push(`✅ **All ${passed} tests passed** (${duration}s)`);
} else {
  lines.push(
    `❌ **${failed} failed**, ${passed} passed, ${skipped ? skipped + ' skipped, ' : ''}${total} total (${duration}s)`,
  );
}
lines.push('');

// ── Summary table ──────────────────────────────────────────────────────
lines.push('## Suite Summary');
lines.push('');
lines.push('| Status | Suite | Passed | Failed | Duration |');
lines.push('|--------|-------|--------|--------|----------|');

for (const suite of results.testResults || []) {
  const name = suite.name.replace(/\\/g, '/').replace(/^.*?(?:src|test)\//, '');
  const suitePassed = suite.assertionResults?.filter((t) => t.status === 'passed').length || 0;
  const suiteFailed = suite.assertionResults?.filter((t) => t.status === 'failed').length || 0;
  const suiteMs = ((suite.endTime - suite.startTime) / 1000).toFixed(2);
  const icon = suiteFailed > 0 ? '❌' : '✅';
  lines.push(`| ${icon} | ${name} | ${suitePassed} | ${suiteFailed} | ${suiteMs}s |`);
}
lines.push('');

// ── Failed test details ────────────────────────────────────────────────
const failedTests = [];
for (const suite of results.testResults || []) {
  for (const test of suite.assertionResults || []) {
    if (test.status === 'failed') {
      failedTests.push({
        suite: suite.name.replace(/\\/g, '/').replace(/^.*?(?:src|test)\//, ''),
        name: test.fullName || test.title,
        message: (test.failureMessages || []).join('\n').slice(0, 500),
      });
    }
  }
}

if (failedTests.length > 0) {
  lines.push('## Failed Tests');
  lines.push('');
  for (const t of failedTests) {
    lines.push(`### ❌ ${t.name}`);
    lines.push(`**Suite:** \`${t.suite}\``);
    lines.push('');
    // Clean ANSI codes from error messages
    const cleanMsg = t.message.replace(/\x1b\[[0-9;]*m/g, '');
    lines.push('```');
    lines.push(cleanMsg);
    lines.push('```');
    lines.push('');
  }
}

const markdown = lines.join('\n');

// ── Output to both CLI and file ────────────────────────────────────────
console.log(markdown);
writeFileSync(reportPath, markdown, 'utf-8');
console.log(`\n📄 Report written to: ${reportPath}`);

process.exit(failed > 0 ? 1 : 0);
