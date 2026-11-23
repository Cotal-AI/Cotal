/**
 * Codex's approval requests and questions on the agent's prompt desk (SPEC 13.22), with no broker.
 *
 * App-server requests, in the shape codex 0.162 sends them, drive the shipped prompt module against
 * the shipped prompt desk. An answer is a `prompt-answer` call on the desk's own handler, and what the
 * module writes back is what the driver would send as the request's JSON-RPC result. Covered: the
 * command, stdin and file change approvals, the decisions a server lists, questions as a form, a
 * secret question, a request nobody resolves until the desk closes, a request the app-server
 * resolves first, an answer after the app-server is gone, no desk, and the Connector's declaration.
 *
 * Run: pnpm smoke:codex-prompts
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentPrompt, CotalEndpoint, EpPrincipalServeContext, PromptState, PromptsOutput } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import type { ServerRequest } from "../src/app-server.js";
import { codexConnector } from "../src/extension.js";
import { createCodexPrompts, type CodexPrompts } from "../src/prompts.js";

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const PRINCIPAL = { owner: "u_alice", actor: "coder", uid: "a".repeat(26), runtimeId: "r".repeat(16) };
const ANSWERER = { owner: "u_alice", actor: "web", uid: "w".repeat(26) };

interface World {
  desk: ServedPromptDesk;
  prompts: CodexPrompts;
  /** Every result the module wrote, by request id. */
  written: { id: number | string; result: unknown }[];
  /** Whether the request's app-server is still there to take a result. */
  live: boolean;
  warnings: string[];
}

function world(opts: { served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const desk = createPromptDesk(ep, () => {});
  const w = { desk, written: [], live: true, warnings: [] } as unknown as World;
  w.prompts = createCodexPrompts({
    desk: () => (opts.served === false ? undefined : desk),
    respond: (request, result) => {
      if (!w.live) return false;
      w.written.push({ id: request.id, result });
      return true;
    },
    warn: (m) => w.warnings.push(m),
  });
  return w;
}

function call(w: World, command: string, args: Record<string, unknown>): unknown {
  const def = w.desk.handlers().find((d) => d.command === command)!;
  return def.handler({
    endpoint: "agent", principal: PRINCIPAL, caller: ANSWERER, authority: "owner",
    request: { v: 1, id: "req", command, args }, receivedAtMonotonicMs: performance.now(),
    replyFits: () => true, signal: new AbortController().signal,
  } as unknown as EpPrincipalServeContext);
}
const list = (w: World) => call(w, "prompts", {}) as PromptsOutput;
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
const state = (w: World, id: string): PromptState | undefined => [...list(w).open, ...list(w).closed].find((s) => s.id === id)?.state;
async function answer(w: World, id: string, option: string, values?: Record<string, unknown>): Promise<void> {
  const p = read(w, id);
  await (call(w, "prompt-answer", { id, digest: p.digest, option, ...(values ? { values } : {}) }) as Promise<unknown>);
  await flush();
}

let nextId = 0;
const request = (method: string, params: Record<string, unknown>): ServerRequest => ({ id: ++nextId, method, params: { threadId: "th", turnId: "tu", ...params }, gen: 1 });
/** Hold `req` and return the id of the prompt it opened. */
function hold(w: World, req: ServerRequest): string | undefined {
  const before = new Set(list(w).open.map((s) => s.id));
  if (!w.prompts.hold(req)) return undefined;
  return list(w).open.map((s) => s.id).find((id) => !before.has(id));
}

// ---- a command approval ------------------------------------------------------------------------
{
  const w = world();
  const req = request("item/commandExecution/requestApproval", { itemId: "call_1", kind: "command", command: "touch x", cwd: "/work", reason: "needs to write" });
  const id = hold(w, req)!;
  const c = id ? read(w, id).content : undefined;
  check("a command approval opens a permission prompt for exec_command with the command and cwd",
    c?.kind === "permission" && c.title === "Run this command?" &&
      isDeepStrictEqual(c.subject, { type: "tool", name: "exec_command", input: { kind: "shown", value: { cmd: "touch x" } }, cwd: "/work" }), c);
  check("it names the call it gates and shows the reason", c?.source?.toolCallId === "call_1" && c?.source?.harness === "codex" && c?.body?.text === "needs to write", c);
  check("it offers Codex's four decisions", isDeepStrictEqual(c?.options.map((o) => [o.id, o.effect]), [["accept", "proceed"], ["accept-for-session", "proceed"], ["decline", "refuse"], ["cancel", "cancel"]]), c?.options);
  await answer(w, id, "accept");
  check("an accepted answer is written as the request's decision", isDeepStrictEqual(w.written, [{ id: req.id, result: { decision: "accept" } }]), w.written);
  check("the prompt is sent and delivered", state(w, id)?.kind === "sent", state(w, id));
  check("the app-server resolving it says the module held it", w.prompts.resolved(req.id) === true);
  const s = state(w, id);
  check("the prompt then closes unconfirmed: resolved does not say who answered", s?.kind === "closed" && s.outcome.kind === "unconfirmed", s);
  check("a second resolve of the same request is not the module's", w.prompts.resolved(req.id) === false);
}

// ---- stdin, the listed decisions, and a refusal ------------------------------------------------
{
  const w = world();
  const req = request("item/commandExecution/requestApproval", { itemId: "call_2", kind: "writeStdin", availableDecisions: ["accept", "decline", "cancel"] });
  const id = hold(w, req)!;
  const c = read(w, id).content;
  check("a stdin approval asks to send input, for write_stdin", c.title === "Send input to the running command?" && (c.subject as { name: string }).name === "write_stdin", c);
  check("a server that lists its decisions gets only those", isDeepStrictEqual(c.options.map((o) => o.id), ["accept", "decline", "cancel"]), c.options);
  check("an option carries only the desk's fields", c.options.every((o) => !("decision" in o)), c.options);
  await answer(w, id, "cancel");
  check("a cancel is written as Codex's cancel decision", isDeepStrictEqual(w.written.at(-1)?.result, { decision: "cancel" }), w.written);
}

// ---- a file change -----------------------------------------------------------------------------
{
  const w = world();
  const changes = [{ path: "/work/a.txt", kind: { type: "add" }, diff: "hello\n" }];
  w.prompts.itemStarted({ type: "fileChange", id: "call_3", changes, status: "inProgress" });
  const req = request("item/fileChange/requestApproval", { itemId: "call_3", grantRoot: "/work" });
  const id = hold(w, req)!;
  const c = read(w, id).content;
  check("a file change approval shows the item's proposed changes under apply_patch",
    c.title === "Apply these file changes?" && isDeepStrictEqual(c.subject, { type: "tool", name: "apply_patch", input: { kind: "shown", value: { changes } } }), c);
  check("it says when Codex also asks to write under a root", c.body?.text === "Codex also asks to write under /work for the rest of the session.", c.body);
  await answer(w, id, "decline");
  check("a deny is written as Codex's decline decision", isDeepStrictEqual(w.written.at(-1)?.result, { decision: "decline" }), w.written);
  w.prompts.itemCompleted({ type: "fileChange", id: "call_3", status: "declined" });
  const later = request("item/fileChange/requestApproval", { itemId: "call_3" });
  const laterId = hold(w, later)!;
  check("a completed item's changes are not kept", isDeepStrictEqual((read(w, laterId).content.subject as { input: unknown }).input, { kind: "shown", value: { changes: [] } }));
}

// ---- questions ---------------------------------------------------------------------------------
{
  const w = world();
  const req = request("item/tool/requestUserInput", {
    itemId: "call_4", isBlocking: true, autoResolutionMs: null,
    questions: [
      { id: "color", header: "Color", question: "Which color?", isOther: false, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }] },
      { id: "name", header: "Name", question: "What name?", isOther: true, isSecret: false, options: [{ label: "Ada", description: "" }] },
    ],
  });
  const id = hold(w, req)!;
  const c = read(w, id).content;
  const props = (c.form?.schema as { properties: Record<string, Record<string, unknown>>; required: string[] }) ?? {};
  check("questions open one form prompt with a submit option", c.kind === "question" && c.title === "Codex asks 2 questions" && c.options.some((o) => o.form === "required"), c);
  check("a question with choices and no free answer is a single choice",
    isDeepStrictEqual(props.properties?.color?.oneOf, [{ const: "Red", title: "Red", description: "warm" }, { const: "Blue", title: "Blue" }]), props.properties?.color);
  check("a question that takes its own answer is a string naming the choices",
    props.properties?.name?.type === "string" && props.properties.name.oneOf === undefined && String(props.properties.name.description).includes("Ada"), props.properties?.name);
  check("every question is required", isDeepStrictEqual(props.required, ["color", "name"]), props.required);
  await answer(w, id, "submit", { color: "Red", name: "Grace" });
  check("submitted values are written as Codex's answers",
    isDeepStrictEqual(w.written.at(-1)?.result, { answers: { color: { answers: ["Red"] }, name: { answers: ["Grace"] } } }), w.written.at(-1));

  const skip = request("item/tool/requestUserInput", { itemId: "call_5", questions: [{ id: "q", header: "Q", question: "?", isOther: true, isSecret: false, options: null }] });
  const skipId = hold(w, skip)!;
  await answer(w, skipId, "decline");
  check("a declined question is written as no answers", isDeepStrictEqual(w.written.at(-1), { id: skip.id, result: { answers: {} } }), w.written.at(-1));

  const secret = request("item/tool/requestUserInput", { itemId: "call_6", questions: [{ id: "pw", header: "Password", question: "?", isOther: true, isSecret: true, options: null }] });
  check("a secret question is not put on the desk", w.prompts.hold(secret) === false);
}

// ---- requests the module leaves to the driver --------------------------------------------------
{
  const w = world({ served: false });
  check("with no desk served, nothing is held", w.prompts.hold(request("item/commandExecution/requestApproval", { itemId: "c" })) === false);
  const v = world();
  check("a request kind the module does not know is not held", v.prompts.hold(request("item/permissions/requestApproval", { itemId: "c" })) === false);
  check("a request with no item is not held", v.prompts.hold(request("item/commandExecution/requestApproval", {})) === false);
}

// ---- the app-server stops waiting, goes away, or nobody answers --------------------------------
{
  const w = world();
  const req = request("item/commandExecution/requestApproval", { itemId: "call_7", command: "ls" });
  const id = hold(w, req)!;
  w.prompts.resolved(req.id);
  const s = state(w, id);
  check("a request resolved before any answer, as from the attached TUI, withdraws its prompt with nothing written",
    s?.kind === "closed" && s.outcome.kind === "withdrawn" && w.written.length === 0, { s, written: w.written });

  const gone = request("item/commandExecution/requestApproval", { itemId: "call_8", command: "ls" });
  const goneId = hold(w, gone)!;
  w.live = false;
  await answer(w, goneId, "accept");
  const g = state(w, goneId);
  check("an answer after the app-server went away is undelivered", g?.kind === "closed" && g.outcome.kind === "undelivered", g);

  w.live = true;
  const left = request("item/commandExecution/requestApproval", { itemId: "call_9", command: "ls" });
  const leftId = hold(w, left)!;
  w.prompts.closed();
  check("the app-server exiting withdraws the prompt and writes nothing", state(w, leftId)?.kind === "closed" && w.written.length === 0, { state: state(w, leftId), written: w.written });

  const waiting = request("item/tool/requestUserInput", { itemId: "call_10", questions: [{ id: "q", header: "Q", question: "?", isOther: true, isSecret: false, options: null }] });
  hold(w, waiting);
  const approval = request("item/fileChange/requestApproval", { itemId: "call_11" });
  hold(w, approval);
  w.desk.close();
  check("a request still waiting when the desk closes is declined in its own shape",
    isDeepStrictEqual(w.written, [{ id: waiting.id, result: { answers: {} } }, { id: approval.id, result: { decision: "decline" } }]), w.written);
}

check("the Codex connector declares prompts", codexConnector.prompts === true);

finish();
