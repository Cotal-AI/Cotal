/**
 * The Cotal mesh sidecar — the long-lived TypeScript half of the Hermes connector.
 *
 * It owns the single {@link MeshAgent} for the gateway's whole life (NATS, presence, the
 * stream-backed inbox, attention modes, manager control) and exposes two local sockets the
 * in-gateway Python plugin connects to:
 *   - the connector-core **control socket** ← presence hooks (relay.ts pattern),
 *   - the **bridge socket** ⇄ inbound push / outbound replies / cotal_* tool calls (bridge.ts).
 * It also writes the generated tool descriptors to **`COTAL_TOOLS_FILE`** so the plugin can
 * register the `cotal_*` tools synchronously at load, without blocking on the bridge.
 *
 * Both entrypoints reuse this: `launch.ts` (managed — also spawns `hermes gateway run` as a child)
 * and `standalone.ts` (a user's own gateway spawns the bundled sidecar itself). Whoever spawns the
 * sidecar sets the three socket/file env vars; we throw if any is missing (no silent fallback).
 */
import { writeFileSync } from "node:fs";
import {
  configFromEnv,
  controlFromEnv,
  MeshAgent,
  startControlServer,
  type AgentConfig,
} from "@cotal-ai/connector-core";
import { hermesHookHandle } from "./hermes-hooks.js";
import { startBridgeServer } from "./bridge.js";
import { hermesToolDescriptors } from "./tool-schema.js";

export interface Sidecar {
  agent: MeshAgent;
  config: AgentConfig;
  stop(): Promise<void>;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set — the sidecar must be spawned with bridge/control/tools paths`);
  return v;
}

/** Start the mesh agent, the control + bridge servers, and emit the tool descriptors file.
 *  Reads `COTAL_CONTROL_SOCKET`, `COTAL_BRIDGE_SOCKET`, and `COTAL_TOOLS_FILE` from the env, and the
 *  control token from the launch material (see controlFromEnv). */
export function startSidecar(): Sidecar {
  const config = configFromEnv();
  config.connector = "hermes"; // advertise the host harness on our AgentCard (meta.connector)
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry

  // Socket path from the env, first-frame token from the launch material the launcher merged it
  // into. Absent means the launcher did not mint a control endpoint, which is a broken launch here.
  const control = controlFromEnv();
  if (!control)
    throw new Error("COTAL_CONTROL_SOCKET / the launch material's control token not set - the sidecar must be spawned with bridge/control/tools paths");
  const controlSock = control.path;
  const controlToken = control.token;
  const bridgeSock = need("COTAL_BRIDGE_SOCKET");
  const toolsFile = need("COTAL_TOOLS_FILE");

  // Managed listener: own the endpoint (fatal bind) and authenticate every frame against the token.
  const controlServer = startControlServer(
    agent,
    { path: controlSock, token: controlToken },
    hermesHookHandle,
    { fatalBind: true },
  );
  const bridge = startBridgeServer(agent, config, bridgeSock);

  // The plugin reads this at register(ctx) time to declare the cotal_* tools (full shared parity).
  writeFileSync(toolsFile, JSON.stringify(hermesToolDescriptors(config)));

  return {
    agent,
    config,
    async stop() {
      try {
        bridge.close();
      } catch {
        /* ignore */
      }
      try {
        controlServer.close();
      } catch {
        /* ignore */
      }
      await agent.stop();
    },
  };
}
