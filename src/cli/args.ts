/**
 * Minimal, dependency-free argument parser. Flags listed in VALUE_FLAGS consume a
 * following value; everything else is boolean. `--key=value` is always a value.
 * Repeated flags are preserved (e.g. multiple `--worker`).
 */

const VALUE_FLAGS = new Set([
  'root',
  'idea',
  'prd',
  'spec',
  'readme',
  'issue',
  'planner',
  'worker',
  'reviewer',
  'concurrency',
  'interval',
  'base',
  'remote',
  'run',
  'level',
  'retries',
  // interview / intake
  'interview',
  'mode',
  'answers',
  // github triage / kanban
  'repo',
  'label',
  'status',
  'max-iterations',
  'project',
]);

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, Array<string | boolean>>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, Array<string | boolean>>();
  let command: string | undefined;

  const push = (key: string, value: string | boolean): void => {
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
      } else if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        push(body, argv[++i]!);
      } else {
        push(body, true);
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const list = args.flags.get(name);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  return typeof last === 'string' ? last : undefined;
}

export function flagAll(args: ParsedArgs, name: string): string[] {
  return (args.flags.get(name) ?? []).filter((v): v is string => typeof v === 'string');
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function flagNum(args: ParsedArgs, name: string): number | undefined {
  const s = flagStr(args, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve the target project root from --root (default cwd). */
export function resolveRoot(args: ParsedArgs): string {
  return flagStr(args, 'root') ?? process.cwd();
}

/** "provider" or "provider:model" → a partial ProviderRef. */
export function parseProviderRef(value: string): { provider: string; model?: string } {
  const idx = value.indexOf(':');
  if (idx < 0) return { provider: value };
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

/** Build config cliOverrides from common provider/execution flags. */
export function cliConfigOverrides(args: ParsedArgs): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const roles: Record<string, unknown> = {};
  const execution: Record<string, unknown> = {};

  const planner = flagStr(args, 'planner');
  if (planner) roles['planner'] = parseProviderRef(planner);
  const workers = flagAll(args, 'worker');
  if (workers.length) roles['workers'] = workers.map(parseProviderRef);
  const reviewer = flagStr(args, 'reviewer');
  if (reviewer) roles['reviewer'] = parseProviderRef(reviewer);

  const concurrency = flagNum(args, 'concurrency');
  if (concurrency !== undefined) execution['concurrency'] = concurrency;
  const retries = flagNum(args, 'retries');
  if (retries !== undefined) execution['maxRetriesPerSlice'] = retries;

  if (Object.keys(roles).length) overrides['roles'] = roles;
  if (Object.keys(execution).length) overrides['execution'] = execution;
  if (flagBool(args, 'auto')) overrides['auto'] = true;
  if (flagBool(args, 'no-color')) overrides['tui'] = { color: false };
  const level = flagStr(args, 'level');
  if (level) overrides['logging'] = { level };
  return overrides;
}
