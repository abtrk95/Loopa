/**
 * Configuration loader with explicit precedence:
 *   built-in defaults → user config → project config → env → CLI overrides
 * (each later source wins). Validation happens once at the end; errors are
 * actionable (which file, which field).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigError } from '../domain/errors.js';
import { projectPaths } from '../util/paths.js';
import { ConfigSchema, type Config } from './config.js';

export interface LoadResult {
  config: Config;
  /** Ordered list of sources that contributed, for `doctor`/provenance. */
  sources: string[];
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge where objects merge recursively and arrays/scalars replace. */
export function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readConfigFile(path: string): Json {
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    if (parsed === null || parsed === undefined) return {};
    if (!isPlainObject(parsed)) {
      throw new ConfigError(`config at ${path} must be a mapping/object`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`failed to parse config at ${path}: ${(err as Error).message}`);
  }
}

function userConfigCandidates(): string[] {
  const home = homedir();
  const xdg = process.env['XDG_CONFIG_HOME'];
  const list = [
    process.env['AGENT_LOOP_CONFIG'],
    xdg ? join(xdg, 'agent-loop', 'config.yml') : undefined,
    join(home, '.config', 'agent-loop', 'config.yml'),
    join(home, '.agent-loop', 'config.yml'),
  ];
  return list.filter((p): p is string => typeof p === 'string');
}

/** "provider" or "provider:model" → partial ProviderRef. */
function parseRef(value: string): Json {
  const idx = value.indexOf(':');
  if (idx < 0) return { provider: value };
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

/** Map a documented subset of env vars into a config partial. */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): Json {
  const out: Json = {};
  const roles: Json = {};
  const execution: Json = {};
  const tui: Json = {};
  const github: Json = {};
  const logging: Json = {};

  if (env['AGENT_LOOP_AUTO']) out['auto'] = truthy(env['AGENT_LOOP_AUTO']);
  if (env['AGENT_LOOP_PLANNER']) roles['planner'] = parseRef(env['AGENT_LOOP_PLANNER']);
  if (env['AGENT_LOOP_WORKER']) roles['workers'] = [parseRef(env['AGENT_LOOP_WORKER'])];
  if (env['AGENT_LOOP_REVIEWER']) roles['reviewer'] = parseRef(env['AGENT_LOOP_REVIEWER']);
  if (env['AGENT_LOOP_CONCURRENCY']) execution['concurrency'] = Number(env['AGENT_LOOP_CONCURRENCY']);
  if (env['AGENT_LOOP_MAX_RETRIES']) execution['maxRetriesPerSlice'] = Number(env['AGENT_LOOP_MAX_RETRIES']);
  if (env['AGENT_LOOP_LOG_LEVEL']) logging['level'] = env['AGENT_LOOP_LOG_LEVEL'];
  if (env['AGENT_LOOP_NO_COLOR'] || env['NO_COLOR']) tui['color'] = false;
  if (env['AGENT_LOOP_GITHUB']) github['enabled'] = truthy(env['AGENT_LOOP_GITHUB']);

  if (Object.keys(roles).length) out['roles'] = roles;
  if (Object.keys(execution).length) out['execution'] = execution;
  if (Object.keys(tui).length) out['tui'] = tui;
  if (Object.keys(github).length) out['github'] = github;
  if (Object.keys(logging).length) out['logging'] = logging;
  return out;
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true' || v?.toLowerCase() === 'yes';
}

export interface LoadOptions {
  root: string;
  cliOverrides?: Json;
  env?: NodeJS.ProcessEnv;
  /** Skip user-level config (used in tests for determinism). */
  skipUserConfig?: boolean;
}

export function loadConfig(opts: LoadOptions): LoadResult {
  const sources: string[] = ['defaults'];
  let merged: Json = {};

  if (!opts.skipUserConfig) {
    for (const candidate of userConfigCandidates()) {
      if (existsSync(candidate)) {
        merged = deepMerge(merged, readConfigFile(candidate));
        sources.push(`user:${candidate}`);
        break;
      }
    }
  }

  const projectCfg = projectPaths(opts.root).configYml;
  if (existsSync(projectCfg)) {
    merged = deepMerge(merged, readConfigFile(projectCfg));
    sources.push(`project:${projectCfg}`);
  }

  const env = envOverrides(opts.env ?? process.env);
  if (Object.keys(env).length) {
    merged = deepMerge(merged, env);
    sources.push('env');
  }

  if (opts.cliOverrides && Object.keys(opts.cliOverrides).length) {
    merged = deepMerge(merged, opts.cliOverrides);
    sources.push('cli');
  }

  try {
    return { config: ConfigSchema.parse(merged), sources };
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
      throw new ConfigError(`invalid configuration:\n${issues}`);
    }
    throw err;
  }
}
