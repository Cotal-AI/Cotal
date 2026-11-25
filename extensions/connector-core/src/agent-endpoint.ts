/**
 * The agent's own `agent` endpoint (SPEC 13.22), served once on the principal route (SPEC 13.21). A
 * process serves an endpoint once for its lifecycle, and the served table is exactly the cluster's
 * commands, so this module is the one owner of that serve.
 */
import type { CotalEndpoint, FirstCommand } from "@cotal-ai/core";
import { createCommandLane, servedCommands, type CommandDispatcher, type CommandQueue } from "./agent-commands.js";
import { createNameLane } from "./agent-name.js";
import { PROMPT_DESK_MIN_MAX_PAYLOAD, createPromptDesk, type PromptDesk } from "./prompt-desk.js";

export interface AgentEndpoint {
  /** The prompt desk, where an adapter opens its harness's dialogs. */
  readonly prompts: PromptDesk;
  /** The commands waiting for an idle turn, which the connector runs one per turn. */
  readonly commands: CommandQueue;
  /** Close every prompt and reply to every caller still waiting, refuse every queued command and
   *  every later `set-name` and `set-label`, then stop serving and wait for the handlers in flight.
   *  Does not wait for a `deliver` call that has not ended. */
  close(): Promise<void>;
}

/**
 * Serve this process's `agent` endpoint on `ep` and show the `prompts` and `agentEndpoint` presence
 * fields. Resolves once the broker accepted the subscription. `dispatcher` runs the agent's harness
 * commands, and `onQueued` is told each time a command waits for a turn. Without a dispatcher,
 * `commands` answers `supported: false`, `command` is refused, and `agentEndpoint` shows nothing
 * served. Each time the dispatcher's `watch` reports a change, `agentEndpoint` is derived again.
 * `first` is the command its launch handed the agent, queued before any other. `onNamed` is told
 * when an owner's `set-name` or `set-label` is about to change the name or the label.
 *
 * Rejects on an open mesh, under a static credential and without a lifecycle UID, when the broker
 * refuses the subscription (a credential minted before the rows existed), and when the connection's
 * `max_payload` is under {@link PROMPT_DESK_MIN_MAX_PAYLOAD}, which the largest prompt replies need.
 * Then nothing is served and presence shows neither field. The same checks run on every replaced
 * connection, and a failure there closes the endpoint and warns. Stopping `ep` ends the serve and not
 * the prompts, so call `close()` first: it ends every prompt and gives each open dialog back.
 */
export async function openAgentEndpoint(
  ep: CotalEndpoint,
  opts: { warn(msg: string): void; dispatcher?: CommandDispatcher; onQueued?(): void; first?: FirstCommand; onNamed?(): void },
): Promise<AgentEndpoint> {
  if (typeof opts?.warn !== "function") throw new TypeError("openAgentEndpoint needs opts.warn");
  const max = ep.maxPayload;
  if (max < PROMPT_DESK_MIN_MAX_PAYLOAD)
    throw new Error(`the agent endpoint needs a connection whose max_payload is at least ${PROMPT_DESK_MIN_MAX_PAYLOAD} bytes, and this one is ${max}`);
  const warn = (msg: string): void => {
    try {
      opts.warn(msg);
    } catch { /* a logger that throws stops nothing */ }
  };
  const desk = createPromptDesk(ep, warn);
  const lane = createCommandLane(opts.dispatcher, opts.onQueued ?? (() => {}), opts.first);
  const naming = createNameLane(ep, warn, opts.onNamed);
  const serve = ep.servePrincipal({ handlers: [...desk.handlers(), ...lane.handlers, ...naming.handlers] });
  desk.served(serve.ready);

  let closing: Promise<void> | undefined;
  const showServed = (): void => {
    if (closing) return;
    ep.setAgentEndpointPresence(servedCommands(opts.dispatcher)).catch((e) => warn(`presence does not show what the agent endpoint serves: ${(e as Error).message}`));
  };
  showServed();
  opts.dispatcher?.watch?.(showServed);
  const close = (): Promise<void> => (closing ??= (() => {
    ep.off("transport", onTransport);
    desk.close();
    lane.close();
    naming.close();
    return serve.stop();
  })());
  const onTransport = (t: { connected: boolean }): void => {
    if (!t.connected || closing) return;
    let now: number;
    try {
      now = ep.maxPayload;
    } catch {
      return; // not live after all; the next connection runs the check
    }
    if (now >= PROMPT_DESK_MIN_MAX_PAYLOAD) return;
    warn(`the agent endpoint closed: the connection's max_payload is ${now} bytes, under the ${PROMPT_DESK_MIN_MAX_PAYLOAD} its largest replies need`);
    void close();
  };
  ep.on("transport", onTransport);
  void serve.failed.then((err) => {
    if (closing) return;
    warn(`the agent endpoint closed: ${err.message}`);
    void close();
  });
  try {
    await serve.ready;
  } catch (e) {
    void close();
    throw e;
  }
  return { prompts: desk, commands: lane, close };
}
