/**
 * What an agent's presence says its `agent` endpoint serves (SPEC §6, §13.22), derived from its
 * dispatcher, with no broker.
 *
 * Covered: no dispatcher serves nothing; a pi-like dispatcher (commands, interrupt, turn, images,
 * usage) serves all four; one without images or without turn serves only what it has. A dispatcher
 * whose `unsupported()` names a cause serves neither `interrupt` nor `turn` nor `images` and still
 * serves `usage`, and `turn` is then refused `unimplemented` with that cause, as `command` and
 * `interrupt` are. `openAgentEndpoint` shows the derived value when it serves, calls the dispatcher's
 * `watch` once, shows the value again each time the dispatcher says it changed, and shows nothing
 * after it closed.
 *
 * Run: pnpm smoke:agent-endpoint-served
 */
import { EpEnvelopeError, type PresenceAgentEndpoint } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createCommandLane, servedCommands, type CommandDispatcher } from "../src/agent-commands.js";
import { openAgentEndpoint } from "../src/agent-endpoint.js";

const { check, finish } = createSuite();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const served = (interrupt: boolean, turn: boolean, images: boolean, usage: boolean): PresenceAgentEndpoint => ({ interrupt, turn, images, usage });

function dispatcher(o: { interrupt?: boolean; turn?: boolean; images?: boolean; usage?: boolean; cause?: () => string | undefined } = {}): CommandDispatcher & { watched: (() => void)[] } {
  const watched: (() => void)[] = [];
  return {
    watched,
    targets: new Set(["command"]),
    list: async () => [],
    dispatch: async () => {},
    ...(o.cause ? { unsupported: o.cause } : {}),
    ...(o.interrupt ? { interrupt: async () => "idle" as const } : {}),
    ...(o.turn ? { turn: async () => {} } : {}),
    ...(o.images ? { images: true } : {}),
    ...(o.usage ? { usage: async () => ({}) } : {}),
    watch: (changed) => void watched.push(changed),
  };
}

const PI_LIKE = { interrupt: true, turn: true, images: true, usage: true };

console.log("\nthe derivation");
check("no dispatcher serves nothing", same(servedCommands(undefined), served(false, false, false, false)));
check("a pi-like dispatcher serves interrupt, turn, images and usage", same(servedCommands(dispatcher(PI_LIKE)), served(true, true, true, true)));
check("a dispatcher that takes turns without images serves turn and no images", same(servedCommands(dispatcher({ ...PI_LIKE, images: false })), served(true, true, false, true)));
check("images without turn are not served", same(servedCommands(dispatcher({ images: true, interrupt: true })), served(true, false, false, false)));
check("a dispatcher with only commands serves none of the four", same(servedCommands(dispatcher()), served(false, false, false, false)));

let cause: string | undefined = "the command mod is not running";
const flipping = dispatcher({ ...PI_LIKE, cause: () => cause });
check("while unsupported() names a cause: no interrupt, turn or images, and usage still served", same(servedCommands(flipping), served(false, false, false, true)));
cause = undefined;
check("once it names none: all four", same(servedCommands(flipping), served(true, true, true, true)));

console.log("\nthe endpoint refuses what presence does not show");
{
  cause = "the command mod is not running";
  const lane = createCommandLane(flipping, () => {});
  const turn = lane.handlers.find((h) => h.command === "turn")!;
  const ctx = { request: { args: { text: "hello" } }, principal: { owner: "u_a", actor: "coder" }, caller: { owner: "u_a", actor: "web" } } as never;
  let refusal: unknown;
  try { await turn.handler(ctx); } catch (e) { refusal = e; }
  check("turn is unimplemented, not-executed, naming the cause, while unsupported() names one",
    refusal instanceof EpEnvelopeError && refusal.code === "unimplemented" && refusal.outcome === "not-executed" && refusal.message.includes(cause), (refusal as Error)?.message);
  cause = undefined;
  const accepted = await turn.handler(ctx) as { id?: string };
  check("...and queued once it names none", typeof accepted?.id === "string" && lane.queued === 1);
  lane.close();
}

console.log("\nopenAgentEndpoint shows it and follows the dispatcher");
{
  const shown: PresenceAgentEndpoint[] = [];
  const fakeEp = {
    maxPayload: 1 << 20,
    on() {}, off() {},
    nextPromptsSeq: () => 0,
    setPromptsPresence: async () => {},
    setAgentEndpointPresence: async (v: PresenceAgentEndpoint) => void shown.push(v),
    servePrincipal: () => ({ ready: Promise.resolve(), failed: new Promise<Error>(() => {}), stop: async () => {} }),
  };
  cause = "the command mod is not running";
  const d = dispatcher({ ...PI_LIKE, cause: () => cause });
  const endpoint = await openAgentEndpoint(fakeEp as never, { warn: () => {}, dispatcher: d });
  check("it shows the derived value when it serves, and calls watch once", same(shown, [served(false, false, false, true)]) && d.watched.length === 1, { shown, watched: d.watched.length });
  cause = undefined;
  d.watched[0]!();
  check("a change the dispatcher reports shows the new value", same(shown.at(-1), served(true, true, true, true)) && shown.length === 2, shown);
  await endpoint.close();
  cause = "gone";
  d.watched[0]!();
  check("after close, a reported change shows nothing", shown.length === 2, shown);

  const plain: PresenceAgentEndpoint[] = [];
  const plainEnd = await openAgentEndpoint({ ...fakeEp, setAgentEndpointPresence: async (v: PresenceAgentEndpoint) => void plain.push(v) } as never, { warn: () => {} });
  check("with no dispatcher it shows all four false", same(plain, [served(false, false, false, false)]), plain);
  await plainEnd.close();
}

finish();
