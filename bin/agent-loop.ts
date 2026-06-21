#!/usr/bin/env node
import '../src/util/sqlite-warning.js'; // suppress node:sqlite ExperimentalWarning, before any load
import { main } from '../src/cli/index.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
