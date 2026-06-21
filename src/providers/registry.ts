/**
 * Provider registry. Builds concrete adapters from config so the orchestration
 * core depends only on the ProviderAdapter interface. Always includes the `fake`
 * provider. Real providers come from presets (claude/codex/opencode) merged with
 * `config.providers.<id>` overrides, or from a fully custom `providers.<id>` entry
 * that supplies a `file`/`baseArgs`.
 */
import { ProcessManager } from '../process/manager.js';
import { ConfigError } from '../domain/errors.js';
import type { Config, FixerRef } from '../config/config.js';
import type { ProviderAdapter } from './types.js';
import { FakeProvider } from './fake.js';
import { CommandProvider, presetSpec, type CommandAdapterSpec } from './command.js';

export class ProviderRegistry {
  private readonly map = new Map<string, ProviderAdapter>();

  add(adapter: ProviderAdapter): void {
    this.map.set(adapter.id, adapter);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  get(id: string): ProviderAdapter {
    const a = this.map.get(id);
    if (!a) throw new ConfigError(`provider '${id}' is not registered`);
    return a;
  }
  ids(): string[] {
    return [...this.map.keys()];
  }
  all(): ProviderAdapter[] {
    return [...this.map.values()];
  }
}

function fixerProvider(fixer: FixerRef): string | undefined {
  return 'strategy' in fixer ? undefined : fixer.provider;
}

/** Every provider id referenced by config (for validation + doctor listing). */
export function referencedProviderIds(config: Config): string[] {
  const ids = new Set<string>(['fake']);
  ids.add(config.roles.planner.provider);
  for (const w of config.roles.workers) ids.add(w.provider);
  if (config.roles.reviewer) ids.add(config.roles.reviewer.provider);
  if (config.roles.judge) ids.add(config.roles.judge.provider);
  if (config.roles.browser) ids.add(config.roles.browser.provider);
  const fp = fixerProvider(config.roles.fixer);
  if (fp) ids.add(fp);
  for (const f of config.routing.fallbackOrder) ids.add(f);
  for (const id of Object.keys(config.providers)) ids.add(id);
  return [...ids];
}

function buildAdapter(
  id: string,
  config: Config,
  root: string,
  pm: ProcessManager,
): ProviderAdapter {
  if (id === 'fake') return new FakeProvider(root);

  const override = (config.providers[id] ?? {}) as Record<string, unknown>;
  const preset = presetSpec(id);

  if (preset) {
    const spec: CommandAdapterSpec = { ...preset };
    applyOverride(spec, override);
    return new CommandProvider(spec, pm);
  }

  // Fully custom provider must supply at least a binary.
  const file = typeof override['file'] === 'string' ? (override['file'] as string) : undefined;
  if (!file) {
    throw new ConfigError(
      `unknown provider '${id}'. Define it under providers.${id} with a 'file' (binary), or use a known provider (fake, claude, codex, opencode).`,
    );
  }
  const spec: CommandAdapterSpec = {
    id,
    file,
    baseArgs: asStringArray(override['baseArgs']) ?? [],
    packDelivery: override['packDelivery'] === 'arg' ? 'arg' : 'stdin',
    versionArgs: asStringArray(override['versionArgs']) ?? ['--version'],
    roles: ['planner', 'worker', 'reviewer', 'fixer', 'judge'],
  };
  applyOverride(spec, override);
  return new CommandProvider(spec, pm);
}

function applyOverride(spec: CommandAdapterSpec, override: Record<string, unknown>): void {
  if (typeof override['file'] === 'string') spec.file = override['file'] as string;
  const baseArgs = asStringArray(override['baseArgs']);
  if (baseArgs) spec.baseArgs = baseArgs;
  const extraArgs = asStringArray(override['args']);
  if (extraArgs) spec.extraArgs = extraArgs;
  if (typeof override['model'] === 'string') spec.defaultModel = override['model'] as string;
  if (override['packDelivery'] === 'arg' || override['packDelivery'] === 'stdin') {
    spec.packDelivery = override['packDelivery'];
  }
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

export function createRegistry(config: Config, root: string, pm = new ProcessManager()): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const id of referencedProviderIds(config)) {
    registry.add(buildAdapter(id, config, root, pm));
  }
  return registry;
}
