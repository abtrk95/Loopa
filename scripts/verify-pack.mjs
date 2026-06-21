#!/usr/bin/env node
/**
 * npm pack dry-run validation (release gate).
 *
 * Runs `npm pack --dry-run --json` and asserts the published tarball ships exactly
 * what it should and NOTHING it shouldn't:
 *   - MUST include: dist/ JS, dist/ types, README.md, THIRD_PARTY_NOTICES.md, docs/.
 *   - MUST NOT include: TypeScript SOURCE (src/**.ts, bin/**.ts), tests, configs.
 * Exits non-zero with a clear report on any violation, so a regression in the
 * `files` allowlist or build output is caught before release.
 */
import { execFileSync } from 'node:child_process';

function pack() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
  return { files, entry };
}

const { files, entry } = pack();
const errors = [];

const has = (pred) => files.some(pred);

// --- MUST be present ---
const required = [
  ['README.md', (f) => f === 'README.md'],
  ['THIRD_PARTY_NOTICES.md', (f) => f === 'THIRD_PARTY_NOTICES.md'],
  ['built CLI (dist/bin/agent-loop.js)', (f) => f === 'dist/bin/agent-loop.js'],
  ['built entry (dist/src/index.js)', (f) => f === 'dist/src/index.js'],
  ['type declarations (dist/**/*.d.ts)', (f) => f.startsWith('dist/') && f.endsWith('.d.ts')],
  ['docs/', (f) => f.startsWith('docs/') && f.endsWith('.md')],
];
for (const [label, pred] of required) {
  if (!has(pred)) errors.push(`MISSING: ${label}`);
}

// --- MUST NOT be present ---
const forbidden = [
  ['TypeScript source under src/', (f) => f.startsWith('src/') && f.endsWith('.ts')],
  ['TypeScript source under bin/', (f) => f.startsWith('bin/') && f.endsWith('.ts') && !f.endsWith('.d.ts')],
  ['tests', (f) => f.startsWith('test/') || /\.test\.[cm]?[jt]s$/.test(f)],
  ['tsconfig', (f) => /^tsconfig.*\.json$/.test(f)],
  ['eslint config', (f) => f.startsWith('eslint.config')],
  ['vitest config', (f) => f.startsWith('vitest.config')],
  ['node_modules', (f) => f.startsWith('node_modules/')],
  ['.agent-loop run state', (f) => f.startsWith('.agent-loop/')],
];
for (const [label, pred] of forbidden) {
  const leaked = files.filter(pred);
  if (leaked.length) errors.push(`LEAKED ${label}: ${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ' …' : ''}`);
}

const name = entry.name ?? 'agent-loop';
const version = entry.version ?? '?';
console.log(`npm pack --dry-run: ${name}@${version} — ${files.length} files, ${fmt(entry.size)} packed / ${fmt(entry.unpackedSize)} unpacked`);

if (errors.length) {
  console.error('\nnpm pack validation FAILED:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('npm pack validation PASSED: ships dist/ + docs/ + README + notices; no source/tests/configs leaked.');

function fmt(bytes) {
  if (typeof bytes !== 'number') return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
