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
  eventPlaneArmed,
  MeshAgent,
  startControlServer,
  type AgentConfig,
} from "@cotal-ai/connector-core";
import { createHermesApprovals } from "./approvals.js";
import { createHermesClarify } from "./clarify.js";
import { gatewayIdle, hermesHookHandle } from "./hermes-hooks.js";
import { startBridgeServer, type BridgeServer, type ListenBridgePipe } from "./bridge.js";
import { drainWhileIdle, hermesCommands } from "./commands.js";
import { startHermesEvents, type HermesEvents } from "./events.js";
import { hermesToolDescriptors } from "./tool-schema.js";

interface Sidecar {
  agent: MeshAgent;
  config: AgentConfig;
  shutdownGateway(): void;
  stop(afterJournal?: () => void): Promise<void>;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set — the sidecar must be spawned with bridge/control/tools paths`);
  return v;
}

/** Start the mesh agent, the control + bridge servers, and emit the tool descriptors file.
 *  Reads `COTAL_CONTROL_SOCKET`, `COTAL_BRIDGE_SOCKET`, and `COTAL_TOOLS_FILE` from the env, and the
 *  control key and version from the launch material (see controlFromEnv). */
export function startSidecar(windows?: { onShutdown(): void; listenPipe: ListenBridgePipe }): Sidecar {
  const config = configFromEnv();
  config.connector = "hermes"; // advertise the host harness on our AgentCard (meta.connector)
  // The gateway posts every turn's output, and its own busy notices, back to the channel as a reply
  // to the message that started the turn. A peer's reply is therefore never a new task for us.
  config.channelRepliesPullOnly = true;
  let bridge: BridgeServer | undefined;
  const agent = new MeshAgent(config, undefined, { commands: hermesCommands(() => bridge) });
  // The launcher names the turn journal only for an armed event plane; an armed plane without one
  // (a standalone sidecar) has nothing to publish from, so it is refused.
  const armed = eventPlaneArmed(config);
  const journal = armed ? process.env.COTAL_HERMES_EVENTS : undefined;
  if (armed && !journal)
    throw new Error("the event plane is armed but the sidecar was given no turn journal (COTAL_HERMES_EVENTS); a standalone Hermes sidecar publishes no event plane");
  let events: HermesEvents | undefined;
  let started = false;
  const startAgent = (): void => {
    if (started) return;
    started = true;
    agent.start();
    if (journal) events = startHermesEvents(agent, config, journal);
  };

  // Socket path from the env, key and version from the launch material the launcher merged them
  // into. Absent means the launcher did not mint a control endpoint, which is a broken launch here.
  const control = controlFromEnv();
  if (!control)
    throw new Error("COTAL_CONTROL_SOCKET / the launch material's control token not set - the sidecar must be spawned with bridge/control/tools paths");
  const bridgeSock = need("COTAL_BRIDGE_SOCKET");
  const toolsFile = need("COTAL_TOOLS_FILE");

  // Managed listener: own the endpoint (fatal bind) and prove every connection through the exchange.
  // Every hook event is also a wake for the event plane's reader: the journal is the data.
  const controlServer = startControlServer(agent, control, (a, ev) => {
    if (journal) events?.holder.flush(journal);
    return hermesHookHandle(a, ev);
  }, { fatalBind: true, onShutdown: windows?.onShutdown });
  const drain = drainWhileIdle(agent, () => bridge);
  agent.on("command", drain);
  const onIdle = (): void => {
    void gatewayIdle(agent, bridge);
    drain();
  };
  const approvals = config.askPermissions
    ? createHermesApprovals({
        desk: () => agent.prompts,
        send: (answer) => bridge?.answerPrompt({ t: "approval_answer", ...answer }) ?? false,
        warn: (msg) => process.stderr.write(`[cotal-hermes] ${msg}\n`),
      })
    : undefined;
  const onApproval = (frame: Record<string, unknown>): void => {
    if (frame.t === "approval") approvals?.request(frame);
    else approvals?.ended(frame);
  };
  const clarify = createHermesClarify({
    desk: () => agent.prompts,
    send: (answer) => bridge?.answerPrompt({ t: "clarify_answer", ...answer }) ?? false,
    warn: (msg) => process.stderr.write(`[cotal-hermes] ${msg}\n`),
  });
  const onClarify = (frame: Record<string, unknown>): void => (frame.t === "clarify" ? clarify.request(frame) : clarify.ended(frame));
  const onDelta = (key: string, text?: string): void => events?.delta(key, text);
  bridge = startBridgeServer(agent, config, bridgeSock, control, { onSubscribe: startAgent, onIdle, onApproval, onClarify, onDelta }, windows?.listenPipe);
  // The launch's initial prompt is the gateway's first turn, in the user's own words. Read once and
  // dropped from the environment the gateway inherits.
  const prompt = process.env.COTAL_HERMES_PROMPT;
  delete process.env.COTAL_HERMES_PROMPT;
  if (prompt)
    bridge.submitTurn(prompt).catch((e: Error) => process.stderr.write(`[cotal-hermes] the initial prompt was not run: ${e.message}\n`));

  // The plugin reads this at register(ctx) time to declare the cotal_* tools (full shared parity).
  writeFileSync(toolsFile, JSON.stringify(hermesToolDescriptors(config)));

  return {
    agent,
    config,
    shutdownGateway() { bridge!.shutdownGateway(); },
    async stop(afterJournal) {
      // Both servers have closed, with every accepted connection ended, before stop resolves, so a
      // launcher that removes their directory next leaves nothing listening or connected in it. A
      // control connection ends on its own within the exchange's deadlines.
      try {
        await Promise.all([bridge!.close(), new Promise<void>((resolve) => controlServer.close(() => resolve()))]);
        await events?.close();
      } finally {
        if (afterJournal) {
          try { afterJournal(); } finally { await agent.stop(); }
        }
      }
      if (!afterJournal) await agent.stop();
    },
  };
}
