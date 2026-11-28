/**
 * The manager's `harness-commands` read (SPEC 13.22): the commands and skills a harness would offer a
 * seat started in a directory on this host, read before any seat exists, under the names the seat's
 * `command` takes. Each connector reads them from its own harness (`Connector.commands`).
 */
import { EpEnvelopeError, fitCommandEntries, loadCotalConfig, ProjectConfigTrustError, rejectionText, spawnEnvAllow, type CommandEntry, type Connector } from "@cotal-ai/core";
import { isCommandFailure, isTrustedProject } from "@cotal-ai/workspace";
import type { ManagerParts } from "./manager-parts.js";

/** `supported: false`: the harness's seats run no commands or skills on this install, for `reason`.
 *  A harness that runs them and failed to list them is an `unavailable` error, never an empty list. */
export type HarnessCommandsOutput = { agent: string; cwd: string } & ({ supported: true; commands: CommandEntry[] } | { supported: false; reason: string });

export async function listHarnessCommands(
  args: Record<string, unknown>,
  parts: Pick<ManagerParts, "connectorInventory" | "harnessResolution" | "seatLaunch">,
  workspaceRoot: string,
): Promise<HarnessCommandsOutput> {
  // The same directory rule a spawn's cwd meets, which also refuses a manager whose seats run elsewhere.
  const { cwd } = parts.seatLaunch.resolveSpawnCwd(args.cwd);
  let connector: Connector;
  try {
    connector = await parts.harnessResolution.resolveConnector(String(args.agent));
  } catch (e) {
    throw new EpEnvelopeError("not-found", rejectionText(e), undefined, "not-executed");
  }
  const agent = connector.name;
  if (!connector.commands) return { agent, cwd, supported: false, reason: `${agent} seats run no commands or skills` };
  await parts.connectorInventory.refreshConnectors(agent, true);
  const harness = parts.harnessResolution.launchHarness(connector);
  if ("refusal" in harness) throw new EpEnvelopeError("failed-precondition", harness.refusal, undefined, "not-executed");
  let envAllow: ReturnType<typeof spawnEnvAllow>;
  try { envAllow = spawnEnvAllow(loadCotalConfig(workspaceRoot, isTrustedProject)); }
  catch (e) {
    if (!(e instanceof ProjectConfigTrustError) && !isCommandFailure(e)) throw e;
    throw new EpEnvelopeError("failed-precondition", e.message, undefined, "not-executed");
  }
  let catalog;
  try {
    catalog = await connector.commands.list({ cwd, resolvedBinaries: harness.binaries, envAllow });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `${agent} did not list its commands: ${rejectionText(e)}`, undefined, "not-executed");
  }
  if (!catalog.supported) return { agent, cwd, ...catalog };
  return { agent, cwd, supported: true, commands: fitCommandEntries(catalog.commands, new Set(connector.commands.targets)) };
}
