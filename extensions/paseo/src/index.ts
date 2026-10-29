/** @cotal-ai/paseo — the Paseo integration: a thin driver over the Paseo daemon (discovery through
 *  the public `paseo` CLI, terminals through the `@getpaseo/client` SDK) plus a self-registering
 *  `paseo` Runtime provider. Importing the package registers it with the core Registry, so the
 *  manager can spawn agents into Paseo workspace terminals. */
export * as paseo from "./driver.js";
export { PaseoRuntime, paseoRuntimeProvider, privateLauncher, TerminalCensus } from "./runtime.js";
