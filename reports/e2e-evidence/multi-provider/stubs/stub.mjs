#!/usr/bin/env node
/**
 * Hermetic stub provider for agent-loop multi-provider validation.
 *
 * Contract it satisfies (see src/providers/command.ts + types.ts):
 *  - Reads the context pack from STDIN (we configure packDelivery: stdin) OR from
 *    the last argv (packDelivery: arg). Extracts agent-loop:slice / agent-loop:role.
 *  - Prints exactly one RESULT_MARKER line of JSON on stdout (the structured result).
 *  - Makes a REAL file edit inside cwd so the deterministic verifier sees a diff.
 *  - Records argv + parsed model + role + sliceId + timestamps + pid to an absolute
 *    JSONL file ($STUB_RECORD_DIR/records.jsonl) so the harness can prove which
 *    provider/model ran, and overlap timing for parallelism.
 *
 * Behaviour toggles (env):
 *  - STUB_NAME            : logical provider name (e.g. claude, codex, ...). REQUIRED.
 *  - STUB_RECORD_DIR      : absolute dir for records.jsonl. REQUIRED.
 *  - STUB_SLEEP_MS        : sleep between start/end records (default 600) to expose overlap.
 *  - STUB_FAIL            : "1" => exit 7 with NO result marker (simulate hard provider failure).
 *  - STUB_FAIL_ATTEMPT    : integer N => fail (exit 7, no result) only when attempt==N.
 *  - STUB_REVIEW_VERDICT  : pass|changes_requested|blocked (reviewer/judge role). default pass.
 *  - STUB_BLOCKER         : if set, worker emits a blocker (no edit).
 *  - STUB_OUT_OF_SCOPE    : "1" => worker writes an out-of-scope file to trigger verifier fail.
 *  - STUB_SECRET          : "1" => worker writes a fake secret to trigger verifier block.
 *  - STUB_WRITE_REL       : explicit relative file to write (default <sliceDir>/<name>.txt).
 */
import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RESULT_MARKER = '__AGENT_LOOP_RESULT__';
const name = process.env.STUB_NAME || 'stub';
const recordDir = process.env.STUB_RECORD_DIR;
if (!recordDir) {
  process.stderr.write('STUB_RECORD_DIR not set\n');
  process.exit(2);
}

// --version handshake (CommandProvider.detectVersion). args: ['--version']
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(`${name}-stub 9.9.9\n`);
  process.exit(0);
}

// Read the context pack: stdin first (packDelivery stdin), else last argv (arg).
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
let pack = readStdin();
if (!pack || !pack.includes('agent-loop:')) {
  // packDelivery: arg — pack is the final positional argument.
  const last = argv[argv.length - 1];
  if (last && last.includes('agent-loop:')) pack = last;
}

function marker(re) {
  const m = pack.match(re);
  return m ? m[1] : undefined;
}
const sliceId = marker(/agent-loop:slice\s+([^\s]+)\s*-->/) || 'unknown';
const role = marker(/agent-loop:role\s+([^\s]+)\s*-->/) || 'worker';
const attempt = Number(marker(/agent-loop:attempt\s+([^\s]+)\s*-->/) || '1') || 1;

// Parse the model from argv: claude uses --model M, codex/opencode use -m M.
function parseModel() {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--model' || argv[i] === '-m') && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}
const model = parseModel();

const startNs = Number(process.hrtime.bigint());
const startIso = new Date().toISOString();

function record(phase, extra = {}) {
  const line = JSON.stringify({
    phase,
    name,
    role,
    sliceId,
    attempt,
    model,
    argv,
    pid: process.pid,
    cwd: process.cwd(),
    startIso,
    nowIso: new Date().toISOString(),
    nowNs: Number(process.hrtime.bigint()),
    ...extra,
  });
  mkdirSync(recordDir, { recursive: true });
  appendFileSync(join(recordDir, 'records.jsonl'), line + '\n');
}

record('start');

const sleepMs = Number(process.env.STUB_SLEEP_MS || '600');
const failAttempt = process.env.STUB_FAIL_ATTEMPT ? Number(process.env.STUB_FAIL_ATTEMPT) : undefined;
const shouldFail = process.env.STUB_FAIL === '1' || (failAttempt !== undefined && failAttempt === attempt);

function emit(obj) {
  process.stdout.write(`${RESULT_MARKER} ${JSON.stringify(obj)}\n`);
}

// Busy-sleep replacement: real async sleep so process overlaps in wallclock.
await new Promise((r) => setTimeout(r, sleepMs));

if (role === 'reviewer' || role === 'judge') {
  const verdict = process.env.STUB_REVIEW_VERDICT || 'pass';
  record('end', { kind: 'review', verdict });
  emit({ verdict, findings: [], summary: `${name} review: ${verdict}` });
  process.exit(0);
}

// worker / fixer
if (shouldFail) {
  record('end', { kind: 'hard-fail' });
  process.stderr.write(`${name}: simulated hard failure (no result)\n`);
  process.exit(7);
}

if (process.env.STUB_BLOCKER) {
  record('end', { kind: 'blocker' });
  emit({ blocker: process.env.STUB_BLOCKER });
  process.exit(0);
}

// Decide what file to write (must stay in slice allowedPaths unless testing scope).
let rel;
if (process.env.STUB_SECRET === '1') {
  rel = `${sliceForDir(sliceId)}/leak.txt`;
} else if (process.env.STUB_OUT_OF_SCOPE === '1') {
  rel = `OUTSIDE_SCOPE_${name}.txt`;
} else if (process.env.STUB_WRITE_PREFIX) {
  // Distinct file per slice+provider under a SHARED prefix (for overlapping-scope tests).
  rel = `${process.env.STUB_WRITE_PREFIX}/${name}_${sliceId.replace(/[^A-Za-z0-9]/g, '')}.txt`;
} else {
  rel = process.env.STUB_WRITE_REL || `${sliceForDir(sliceId)}/${name}.txt`;
}
const abs = join(process.cwd(), rel);
mkdirSync(dirname(abs), { recursive: true });
let content = `written by ${name} for ${sliceId} attempt ${attempt} model=${model}\n`;
if (process.env.STUB_SECRET === '1') {
  content += 'aws_secret_access_key = AKIAIOSFODNN7EXAMPLEKEYabcd1234567890XYZ\n';
}
writeFileSync(abs, content);

record('end', { kind: 'edit', wrote: rel });
emit({ summary: `${name} implemented ${sliceId}`, filesChanged: [rel] });
process.exit(0);

function sliceForDir(id) {
  // Map S-000 -> slice000 etc. Slices' allowedPaths use a per-slice dir.
  return `slice_${id.replace(/[^A-Za-z0-9]/g, '')}`;
}
