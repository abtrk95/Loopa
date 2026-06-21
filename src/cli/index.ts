import '../util/sqlite-warning.js'; // must be first
import { parseArgs, flagBool, flagStr, flagNum, resolveRoot, type ParsedArgs } from './args.js';
import { AgentLoopError, PlanValidationError, errorMessage } from '../domain/errors.js';
import { cmdInit } from './commands/init.js';
import { cmdPlan } from './commands/plan.js';
import { cmdRun, cmdRetry } from './commands/run.js';
import { cmdStatus, cmdPause, cmdResume, cmdStop, cmdLogs, cmdDiff } from './commands/control.js';
import { cmdDoctor, cmdProviders, cmdInspect } from './commands/info.js';
import { cmdPr } from './commands/pr.js';
import { cmdDemo } from './commands/demo.js';
import { runWatch } from '../watch/dashboard.js';

export const VERSION = '0.1.0';

const HELP = `agent-loop ${VERSION} — local-first autonomous coding loop

USAGE
  agent-loop <command> [options]

COMMANDS
  init                        Scaffold .agent-loop/ config + layout
  plan   --idea "..."         Plan from an idea
         --prd <file>         Plan from a Markdown/JSON PRD
         --spec <file> | --readme <file> | --issue <n> | --stdin
  run    [--auto] [--watch]   Execute the plan (--auto = unattended)
  retry                       Resume a blocked/interrupted run
  watch  [--json|--plain]     Live dashboard (attach from any terminal)
         [--once] [--no-color] [--compact] [--interval <ms>] [--no-git]
  status [--json]             Show run status from verified state
  pause | resume | stop       Control a running engine
  logs   [--follow]           Show structured logs
  diff                        Show the current working-tree diff
  doctor                      Check environment + provider health
  providers                   List providers, versions, health
  inspect [<run-id>]          Explain why a run/slice is in its state
  pr create [--push]          Open a draft PR via gh (never auto-merges)
  demo                        Deterministic demo (no API keys)

ROLE / ROUTING OPTIONS (for plan/run)
  --planner <provider[:model]>     --worker <provider[:model]> (repeatable)
  --reviewer <provider[:model]>    --concurrency <n>   --retries <n>

COMMON
  --root <dir>   --json   --no-color   --help   --version
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (flagBool(args, 'version') || args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.command || flagBool(args, 'help') || args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    return await dispatch(args.command, args);
  } catch (err) {
    if (err instanceof PlanValidationError) {
      process.stderr.write(`error: ${err.message}\n`);
      for (const issue of err.issues) process.stderr.write(`  - ${issue}\n`);
      return 1;
    }
    if (err instanceof AgentLoopError) {
      process.stderr.write(`error [${err.category}]: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`unexpected error: ${errorMessage(err)}\n`);
    if (process.env['AGENT_LOOP_DEBUG']) process.stderr.write(String((err as Error).stack) + '\n');
    return 1;
  }
}

async function dispatch(command: string, args: ParsedArgs): Promise<number> {
  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'plan':
      return await cmdPlan(args);
    case 'run':
      return await cmdRun(args);
    case 'retry':
      return await cmdRetry(args);
    case 'watch':
      return await runWatch(watchOptions(args));
    case 'status':
      return await cmdStatus(args);
    case 'pause':
      return cmdPause(args);
    case 'resume':
      return cmdResume(args);
    case 'stop':
      return cmdStop(args);
    case 'logs':
      return await cmdLogs(args);
    case 'diff':
      return await cmdDiff(args);
    case 'doctor':
      return await cmdDoctor(args);
    case 'providers':
      return await cmdProviders(args);
    case 'inspect':
      return cmdInspect(args);
    case 'pr':
      return await cmdPr(args);
    case 'demo':
      return await cmdDemo(args);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

function watchOptions(args: ParsedArgs): Parameters<typeof runWatch>[0] {
  return {
    root: resolveRoot(args),
    ...(flagStr(args, 'run') ? { runId: flagStr(args, 'run') } : {}),
    json: flagBool(args, 'json'),
    plain: flagBool(args, 'plain'),
    color: !flagBool(args, 'no-color'),
    once: flagBool(args, 'once'),
    compact: flagBool(args, 'compact'),
    noGit: flagBool(args, 'no-git'),
    ...(flagNum(args, 'interval') !== undefined ? { intervalMs: flagNum(args, 'interval') } : {}),
  };
}
