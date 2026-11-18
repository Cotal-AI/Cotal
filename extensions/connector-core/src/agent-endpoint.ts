/**
 * The agent's own `agent` endpoint (SPEC 13.22), served once on the principal route (SPEC 13.21). A
 * process serves an endpoint once for its lifecycle, and the served table is exactly the cluster's
 * commands, so this module is the one owner of that serve. The prompt desk answers its prompt
 * commands; this module knows only the handlers it hands over and when the serve starts and ends.
 */
import type { CotalEndpoint } from "@cotal-ai/core";
import { PROMPT_DESK_MIN_MAX_PAYLOAD, createPromptDesk, type PromptDesk } from "./prompt-desk.js";

export interface AgentEndpoint {
  /** The prompt desk, where an adapter opens its harness's dialogs. */
  readonly prompts: PromptDesk;
  /** Close every prompt and reply to every caller still waiting, then stop serving and wait for the
   *  handlers in flight. Does not wait for a `deliver` call that has not ended. */
  close(): Promise<void>;
}

/**
 * Serve this process's `agent` endpoint on `ep` and show the `prompts` presence field. Resolves once
 * the broker accepted the subscription.
 *
 * Rejects on an open mesh, under a static credential and without a lifecycle UID, when the broker
 * refuses the subscription (a credential minted before the rows existed), and when the connection's
 * `max_payload` is under {@link PROMPT_DESK_MIN_MAX_PAYLOAD}, which the largest prompt replies need.
 * Then nothing is served and presence shows no `prompts` field. The same checks run on every replaced
 * connection, and a failure there closes the endpoint and warns. Stopping `ep` ends the serve and not
 * the prompts, so call `close()` first: it ends every prompt and gives each open dialog back.
 */
export async function openAgentEndpoint(ep: CotalEndpoint, opts: { warn(msg: string): void }): Promise<AgentEndpoint> {
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
  const serve = ep.servePrincipal({ handlers: desk.handlers() });
  desk.served(serve.ready);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= (() => {
    ep.off("transport", onTransport);
    desk.close();
    return serve.stop();
  })());
  // Every replaced connection runs the payload check again.
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
  return { prompts: desk, close };
}
