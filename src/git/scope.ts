/**
 * Path-policy and structural safety checks over the set of files an agent changed.
 *
 * Two layers:
 *  1. Policy: does each changed path fall inside the slice's allowedPaths and
 *     outside forbiddenPaths + global forbidden globs?
 *  2. Structure: detect escapes that policy globs alone can't catch — writes under
 *     .git, path traversal, symlinks pointing outside the tree, submodule edits,
 *     and (optionally) unexpected binary files.
 *
 * These are pure/structural checks; the verifier composes them with command checks
 * to make the authoritative pass/fail decision.
 */
import { lstatSync, readlinkSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Convert a glob (supporting **, *, ?) to an anchored RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const posix = toPosix(path);
  return globs.some((g) => globToRegExp(g).test(posix));
}

export interface ScopeInput {
  changedPaths: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  globalForbidden: string[];
}

export interface ScopeResult {
  ok: boolean;
  /** Changed paths matching no allowed glob. */
  outOfScope: string[];
  /** Changed paths matching a forbidden glob. */
  forbidden: string[];
}

export function evaluateScope(input: ScopeInput): ScopeResult {
  const outOfScope: string[] = [];
  const forbidden: string[] = [];
  const allForbidden = [...input.forbiddenPaths, ...input.globalForbidden];
  for (const path of input.changedPaths) {
    if (matchesAny(path, allForbidden)) {
      forbidden.push(path);
      continue;
    }
    if (input.allowedPaths.length > 0 && !matchesAny(path, input.allowedPaths)) {
      outOfScope.push(path);
    }
  }
  return { ok: outOfScope.length === 0 && forbidden.length === 0, outOfScope, forbidden };
}

export interface StructuralFinding {
  kind: 'git-internal' | 'traversal' | 'symlink-escape' | 'symlink' | 'submodule' | 'binary';
  path: string;
  detail?: string;
}

/**
 * Structural safety scan over changed paths within `dir`. Pure detection — the
 * caller decides severity (block vs flag).
 */
export function structuralScan(
  dir: string,
  changedPaths: string[],
  opts: { flagBinary?: boolean } = {},
): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const rootReal = safeRealpath(dir);
  for (const rel of changedPaths) {
    const posix = toPosix(rel);
    // Writes under .git are never allowed.
    if (posix === '.git' || posix.startsWith('.git/')) {
      findings.push({ kind: 'git-internal', path: rel });
      continue;
    }
    // Path traversal / absolute escapes.
    if (isAbsolute(rel) || normalize(rel).split('/').includes('..')) {
      findings.push({ kind: 'traversal', path: rel });
      continue;
    }
    // Submodule pointer file.
    if (posix === '.gitmodules') {
      findings.push({ kind: 'submodule', path: rel });
    }
    const abs = join(dir, rel);
    let st;
    try {
      st = lstatSync(abs, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st) continue;
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = readlinkSync(abs);
      } catch {
        // unreadable link
      }
      const resolved = resolve(dir, target);
      const escapes = rootReal !== undefined && !resolved.startsWith(rootReal + sep) && resolved !== rootReal;
      findings.push({
        kind: escapes ? 'symlink-escape' : 'symlink',
        path: rel,
        ...(target ? { detail: `-> ${target}` } : {}),
      });
      continue;
    }
    if (opts.flagBinary && st.isFile() && isBinary(abs)) {
      findings.push({ kind: 'binary', path: rel });
    }
  }
  return findings;
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function isBinary(absPath: string): boolean {
  try {
    const buf = readFileSync(absPath);
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}
