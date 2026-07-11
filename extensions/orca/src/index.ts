/** @cotal-ai/orca — the Orca integration: a thin driver over the public Orca CLI plus a
 *  self-registering `orca` Runtime provider. Importing the package registers it with the core
 *  Registry, so the manager can spawn agents into the Orca worktree matching each launch cwd. */
export * as orca from "./driver.js";
export { OrcaRuntime, orcaRuntimeProvider } from "./runtime.js";
