/**
 * Import this module FIRST (before anything that loads node:sqlite) to suppress
 * only the node:sqlite ExperimentalWarning, keeping CLI output clean. Importing it
 * early matters because ESM evaluates imported modules in order, and node:sqlite
 * emits the warning when it is first loaded.
 */
const proc = process as NodeJS.Process & { __agentLoopSqliteWarnPatched?: boolean };
if (!proc.__agentLoopSqliteWarnPatched) {
  proc.__agentLoopSqliteWarnPatched = true;
  const original = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emit = (event: string, ...args: unknown[]): boolean => {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined;
      if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message ?? '')) {
        return false;
      }
    }
    return original(event, ...args);
  };
}
