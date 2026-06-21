/**
 * Role router. Decides which provider+model serves each role for a given slice
 * and attempt, implementing the configured strategies: static, round-robin,
 * weighted, and capability-based worker selection, plus provider fallback and
 * provider-switch-on-retry. Pure over config (+ an optional capability predicate);
 * the executor resolves the concrete adapter from the registry.
 */
import type { Config, ProviderRef } from '../config/config.js';
import type { Role } from '../domain/schemas.js';

export interface Selection {
  provider: string;
  model?: string | undefined;
  options: Record<string, unknown>;
}

function toSelection(ref: ProviderRef): Selection {
  return { provider: ref.provider, ...(ref.model ? { model: ref.model } : {}), options: ref.options };
}

export class Router {
  private workerCursor = 0;
  private readonly expandedWorkers: ProviderRef[];

  constructor(
    private readonly config: Config,
    /** Optional capability check: can `providerId` serve `role`? */
    private readonly canServe: (providerId: string, role: Role) => boolean = () => true,
  ) {
    this.expandedWorkers = this.expandWorkers();
  }

  private expandWorkers(): ProviderRef[] {
    const workers = this.config.roles.workers;
    if (this.config.routing.workerStrategy === 'weighted') {
      const out: ProviderRef[] = [];
      for (const w of workers) for (let i = 0; i < w.weight; i++) out.push(w);
      return out.length ? out : workers;
    }
    return workers;
  }

  planner(): Selection {
    return toSelection(this.config.roles.planner);
  }

  worker(attempt: number): Selection {
    const strategy = this.config.routing.workerStrategy;
    const pool = this.workersCapableOf('worker');
    if (pool.length === 0) {
      // No capable worker — fall back to the first configured worker.
      return toSelection(this.config.roles.workers[0]!);
    }
    if (strategy === 'static') {
      return toSelection(pool[0]!);
    }
    if (strategy === 'capability') {
      // Prefer a stable capable worker, advancing only on retry.
      const idx = Math.min(attempt - 1, pool.length - 1);
      return toSelection(pool[idx]!);
    }
    // round-robin / weighted
    const ref = pool[this.workerCursor % pool.length]!;
    this.workerCursor++;
    if (this.config.routing.switchProviderOnRetry && attempt > 1) {
      // already advanced via cursor; nothing extra needed
    }
    return toSelection(ref);
  }

  private workersCapableOf(role: Role): ProviderRef[] {
    const base = this.expandedWorkers;
    const capable = base.filter((w) => this.canServe(w.provider, role));
    return capable.length ? capable : base;
  }

  reviewer(index = 0): Selection | undefined {
    const r = this.config.roles.reviewer;
    if (!r) return undefined;
    // For consensus >1 we currently reuse the configured reviewer; distinct
    // reviewers can be modelled by capability-aware fallbacks in future.
    void index;
    return toSelection(r);
  }

  reviewerConsensusCount(): number {
    return this.config.roles.reviewer ? this.config.routing.reviewerConsensus : 0;
  }

  fixer(workerSelection: Selection): Selection {
    const fixer = this.config.roles.fixer;
    if ('strategy' in fixer) return workerSelection; // same-as-worker
    return toSelection(fixer);
  }

  judge(): Selection | undefined {
    return this.config.roles.judge ? toSelection(this.config.roles.judge) : undefined;
  }

  /** Fallback providers to try (in order) when `current` fails, excluding it. */
  fallbacks(current: string): Selection[] {
    return this.config.routing.fallbackOrder
      .filter((id) => id !== current)
      .map((id) => ({ provider: id, options: {} }));
  }
}
