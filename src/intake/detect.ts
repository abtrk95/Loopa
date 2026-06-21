/**
 * Repository stack detection. Pure filesystem inspection — no network, no agent.
 * Produces verification command defaults from the project's own tooling so the
 * verifier uses the SAME checks a developer would run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckSpec } from '../domain/schemas.js';

export interface DetectedStack {
  stack: string[];
  packageManager?: string;
  verification: CheckSpec[];
}

function readJsonSafe(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function detectStack(root: string): DetectedStack {
  const stack: string[] = [];
  const verification: CheckSpec[] = [];
  let packageManager: string | undefined;

  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    stack.push('node');
    const pkg = readJsonSafe(pkgPath) ?? {};
    const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
    const deps = {
      ...((pkg['dependencies'] as Record<string, unknown>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, unknown>) ?? {}),
    };
    if (existsSync(join(root, 'tsconfig.json')) || 'typescript' in deps) stack.push('typescript');
    if ('vitest' in deps) stack.push('vitest');
    else if ('jest' in deps) stack.push('jest');

    packageManager = existsSync(join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(root, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(root, 'bun.lockb'))
          ? 'bun'
          : 'npm';
    const run = packageManager === 'npm' ? 'npm run' : `${packageManager} run`;

    const add = (id: string, category: CheckSpec['category'], scriptName: string) => {
      if (typeof scripts[scriptName] === 'string') {
        verification.push(parseCheck({ id, category, command: `${run} ${scriptName}` }));
      }
    };
    add('typecheck', 'typecheck', 'typecheck');
    add('lint', 'lint', 'lint');
    add('test', 'test', 'test');
    add('build', 'build', 'build');
  }

  if (existsSync(join(root, 'go.mod'))) {
    stack.push('go');
    verification.push(
      parseCheck({ id: 'build', category: 'build', command: ['go', 'build', './...'] }),
      parseCheck({ id: 'vet', category: 'lint', command: ['go', 'vet', './...'] }),
      parseCheck({ id: 'test', category: 'test', command: ['go', 'test', './...'] }),
    );
  }

  if (existsSync(join(root, 'Cargo.toml'))) {
    stack.push('rust');
    verification.push(
      parseCheck({ id: 'build', category: 'build', command: ['cargo', 'build'] }),
      parseCheck({ id: 'test', category: 'test', command: ['cargo', 'test'] }),
    );
  }

  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) {
    stack.push('python');
    if (existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'tests'))) {
      verification.push(parseCheck({ id: 'test', category: 'test', command: ['pytest', '-q'] }));
    }
  }

  return { stack, ...(packageManager ? { packageManager } : {}), verification };
}

// Lazy import to avoid a cycle in module init ordering.
function parseCheck(input: {
  id: string;
  category: CheckSpec['category'];
  command: string | string[];
}): CheckSpec {
  return {
    id: input.id,
    category: input.category,
    command: input.command,
    expect: 'exit_zero',
  } as CheckSpec;
}
