// Keep manifest loading and local plugin materialization off the Manager's serving thread.
import { parentPort, workerData } from "node:worker_threads";
import type { Connector, ConnectorSetupInput, ConnectorSetupProvider } from "@cotal-ai/core";
import { materializeFromManifest, OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";
import { runMachineSetupCommand, SetupExitUnconfirmed } from "./machine-setup-command.js";

const { cotal, expectedGeneration, binaries, signal } = workerData as {
  cotal: string[];
  expectedGeneration: string;
  binaries: NonNullable<ConnectorSetupInput["machineHost"]>["binaries"];
  signal: AbortSignal;
};
let exitConfirmed = true;
const run: NonNullable<ConnectorSetupInput["machineHost"]>["run"] = async (file, args, options) => {
  exitConfirmed = false;
  try {
    const result = await runMachineSetupCommand(file, args, options, signal);
    exitConfirmed = true;
    return result;
  } catch (error) {
    exitConfirmed = !(error instanceof SetupExitUnconfirmed);
    throw error;
  }
};
try {
  signal.throwIfAborted();
  const opts = { expectedGeneration, expectedPackage: OFFICIAL_CONNECTORS.claude };
  const connector = await materializeFromManifest<Connector>({ kind: "connector", name: "claude" }, opts);
  if (!connector.setup) throw new Error("Claude connector has no setup provider");
  const provider = await materializeFromManifest<ConnectorSetupProvider>(connector.setup, opts);
  if (!provider.connector) throw new Error("Claude connector has no install action");
  await provider.connector.run({ cotal, machineHost: { binaries, signal, run } });
  if (!exitConfirmed) throw new Error("native setup command exit was not confirmed");
  signal.throwIfAborted();
  parentPort!.postMessage("registered");
} catch (error) {
  if (exitConfirmed) parentPort!.postMessage("settled");
  throw error;
}
