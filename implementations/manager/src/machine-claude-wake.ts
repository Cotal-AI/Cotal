/** Runs the connector's synchronous native setup off the hosted Manager's serving thread. */
import { parentPort, workerData } from "node:worker_threads";
import type { Connector, ConnectorSetupProvider } from "@cotal-ai/core";
import { materializeFromManifest, OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";

const { cotal, expectedGeneration } = workerData as { cotal: string[]; expectedGeneration: string };
const opts = { expectedGeneration, expectedPackage: OFFICIAL_CONNECTORS.claude };
const connector = await materializeFromManifest<Connector>({ kind: "connector", name: "claude" }, opts);
if (!connector.setup) throw new Error("Claude connector has no setup provider");
const provider = await materializeFromManifest<ConnectorSetupProvider>(connector.setup, opts);
if (!provider.connector) throw new Error("Claude connector has no install action");
await provider.connector.run({ cotal, machineHost: true });
parentPort!.postMessage("registered");
