/**
 * A Pi seat launched with `askPermissions` puts each tool call that is not read-only behind the
 * agent's prompt desk, through the shipped `askBeforeTools` on a stand-in for Pi's extension API
 * and connector-core's real desk. One path: a call the desk cannot hold is blocked with a reason
 * that names why, and Pi's own UI is never asked.
 *
 * Covered: read-only and Cotal tools run unasked; the prompt's content; Allow lets the call run;
 * Deny blocks it with the owner's note or a default; Pi finishing the call confirms the answer; a
 * stopped turn withdraws the prompt and blocks the call; an unserved desk, a full desk and a desk
 * that closes block the call with the cause; an input over the size limit is shown by size with
 * only Deny; the connector declares the field and carries it to the seat.
 *
 * Run: pnpm smoke:pi-approvals
 */
import { isDeepStrictEqual } from "node:util";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, type AgentPrompt, type CotalEndpoint, type EpPrincipalServeContext, type PromptState, type PromptsOutput } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import { askBeforeTools, type PiToolCallAnswer } from "../src/approvals.js";
import { piConnector } from "../src/connector.js";

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

type Handler = (event: unknown, context: unknown) => unknown;
interface World {
  desk: ServedPromptDesk;
  handlers: Map<string, Handler>;
  /** Pi's `tool_call`, as its runner calls the handler. */
  toolCall(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PiToolCallAnswer>;
  /** Pi's `tool_execution_end` for a call. */
  ended(toolCallId: string): void;
}

/** What the extension logs, from every world: it logs to Pi's stderr. */
const logged: string[] = [];
console.error = (msg: string) => void logged.push(msg);

let calls = 0;
function world(opts: { served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const desk = createPromptDesk(ep, () => {});
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  askBeforeTools(pi as never, () => (opts.served === false ? undefined : desk));
  return {
    desk, handlers,
    toolCall: (toolName, input, signal) =>
      handlers.get("tool_call")!({ type: "tool_call", toolCallId: `call_${++calls}`, toolName, input }, { signal, cwd: "/work" }) as Promise<PiToolCallAnswer>,
    ended: (toolCallId) => void handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId }, {}),
  };
}

function call(w: World, command: string, args: Record<string, unknown>): unknown {
  const def = w.desk.handlers().find((d) => d.command === command)!;
  return def.handler({
    endpoint: "agent", principal: { owner: "u_alice", actor: "pi", uid: "a".repeat(26), runtimeId: "r".repeat(16) },
    caller: { owner: "u_alice", actor: "web", uid: "w".repeat(26) }, authority: "owner",
    request: { v: 1, id: "req", command, args }, receivedAtMonotonicMs: performance.now(),
    replyFits: () => true, signal: new AbortController().signal,
  } as unknown as EpPrincipalServeContext);
}
const list = (w: World) => call(w, "prompts", {}) as PromptsOutput;
/** The newest prompt still waiting for an answer. */
const asking = (w: World): string => list(w).open.filter((s) => s.state.kind === "open").at(-1)!.id;
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
const stateOf = (w: World, id: string): PromptState | undefined => [...list(w).open, ...list(w).closed].find((s) => s.id === id)?.state;
const closedAs = (s: PromptState | undefined, outcome: Record<string, unknown>) =>
  s?.kind === "closed" && Object.entries(outcome).every(([k, v]) => isDeepStrictEqual((s.outcome as Record<string, unknown>)[k], v));
async function answer(w: World, id: string, option: string, note?: string): Promise<void> {
  await call(w, "prompt-answer", { id, digest: read(w, id).digest, option, ...(note ? { note } : {}) });
  await flush();
}
/** Settles to the handler's answer, or to "pending" while Pi still waits. */
const peek = async (p: Promise<PiToolCallAnswer>): Promise<PiToolCallAnswer | "pending"> => {
  await flush();
  return Promise.race([p, Promise.resolve("pending" as const)]);
};

console.log("Pi tool calls behind the prompt desk");
{
  const w = world();
  check("the extension hooks Pi's tool_call and tool_execution_end", w.handlers.has("tool_call") && w.handlers.has("tool_execution_end"));
  const unasked = await Promise.all(["read", "grep", "find", "ls", "cotal_send"].map((t) => w.toolCall(t, { path: "." })));
  check("read-only and Cotal tools run without a prompt", unasked.every((a) => a === undefined) && list(w).open.length === 0);

  const allowed = w.toolCall("bash", { command: "touch made.txt" });
  await flush();
  const open = list(w).open;
  check("a bash call opens one prompt and Pi waits", open.length === 1 && (await peek(allowed)) === "pending");
  const prompt = read(w, open[0]!.id);
  check("the prompt names the tool, its input, the folder and the call", prompt.content.kind === "permission" && prompt.content.title === "Allow bash?" &&
    isDeepStrictEqual(prompt.content.subject, { type: "tool", name: "bash", input: { kind: "shown", value: { command: "touch made.txt" } }, cwd: "/work" }) &&
    prompt.content.source?.harness === "pi" && prompt.content.source.toolCallId === `call_${calls}`, prompt.content);
  check("it offers Allow and Deny", prompt.content.options.map((o) => `${o.id}:${o.effect}`).join() === "allow:proceed,deny:refuse");
  await answer(w, prompt.id, "allow");
  check("Allow lets the call run", (await peek(allowed)) === undefined);
  check("the prompt waits for Pi to finish the call", stateOf(w, prompt.id)?.kind === "sent", stateOf(w, prompt.id));
  w.ended(prompt.content.source!.toolCallId!);
  await flush();
  check("Pi finishing the call confirms the answer", closedAs(stateOf(w, prompt.id), { kind: "answered" }), stateOf(w, prompt.id));

  const denied = w.toolCall("edit", { path: "a.ts", oldText: "a", newText: "b" });
  await flush();
  await answer(w, asking(w), "deny", "Not that file.");
  check("Deny blocks the call with the owner's note", isDeepStrictEqual(await peek(denied), { block: true, reason: "Not that file." }));
  const plain = w.toolCall("write", { path: "b.ts", content: "x" });
  await flush();
  const plainId = asking(w);
  await answer(w, plainId, "deny");
  check("a Deny with no note blocks with a default reason", isDeepStrictEqual(await peek(plain), { block: true, reason: "The user denied this tool call." }));
  w.ended(read(w, plainId).content.source!.toolCallId!);
  await flush();
  check("Pi recording the blocked call confirms the Deny", closedAs(stateOf(w, plainId), { kind: "answered" }), stateOf(w, plainId));

  const turn = new AbortController();
  const stopped = w.toolCall("bash", { command: "rm -rf build" }, turn.signal);
  await flush();
  const stoppedId = asking(w);
  turn.abort();
  await flush();
  const out = await peek(stopped);
  check("a stopped turn blocks the call it was waiting on", typeof out === "object" && out?.block === true && /stopped/.test(out.reason), out);
  check("and withdraws its prompt", closedAs(stateOf(w, stoppedId), { kind: "withdrawn" }), stateOf(w, stoppedId));

  const big = w.toolCall("write", { path: "big.txt", content: "x".repeat(300_000) });
  await flush();
  const bigPrompt = read(w, asking(w));
  check("an input over the size limit shows by size and offers only Deny",
    (bigPrompt.content.subject as { input: { kind: string } }).input.kind === "omitted" && bigPrompt.content.options.map((o) => o.id).join() === "deny");
  await answer(w, bigPrompt.id, "deny");
  await big;
}

console.log("one path: a call the desk cannot hold is blocked");
{
  const unserved = world({ served: false });
  const out = await unserved.toolCall("bash", { command: "ls" });
  check("no served desk blocks the call and names why", typeof out === "object" && /does not serve its prompt desk/.test(out!.reason) && /not run/.test(out!.reason), out);
  check("and logs it", logged.some((m) => /does not serve its prompt desk/.test(m)), logged);

  const full = world();
  const waiting = Array.from({ length: 32 }, (_, i) => full.toolCall("bash", { command: `echo ${i}` }));
  await flush();
  const refused = await full.toolCall("bash", { command: "echo 33" });
  check("a full desk blocks the call and names why", typeof refused === "object" && refused!.block && /could not ask/.test(refused!.reason), refused);
  full.desk.close();
  await flush();
  const closed = await Promise.all(waiting);
  check("a desk that closes blocks every call still waiting", closed.every((a) => typeof a === "object" && /closed without an answer/.test(a!.reason)), closed[0]);
}

console.log("the launch field");
{
  check("pi declares askPermissions and prompts", piConnector.supportsAskPermissions === true && piConnector.prompts === true);
  const launch = (askPermissions?: boolean) =>
    readLaunchMaterial(piConnector.buildLaunch({ space: "test", name: "pi", events: false, creds: "creds", ...(askPermissions ? { askPermissions } : {}) }).env![LAUNCH_MATERIAL_ENV]!);
  check("an asking launch carries the field to the seat", launch(true).askPermissions === true);
  check("a launch without it carries nothing", launch().askPermissions === undefined);
}

finish();
