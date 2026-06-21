/**
 * Vitest setup: suppress only the node:sqlite ExperimentalWarning so test output
 * stays clean. Runs before any test module imports the event store.
 */
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
