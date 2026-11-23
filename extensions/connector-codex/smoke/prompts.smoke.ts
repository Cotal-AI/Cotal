/**
 * Codex's approval requests and questions on the agent's prompt desk (SPEC 13.22), with no broker.
 *
 * App-server requests, in the shape codex 0.162 sends them, drive the shipped prompt module against
 * the shipped prompt desk. An answer is a `prompt-answer` call on the desk's own handler, and what the
 * module writes back is what the driver would send as the request's JSON-RPC result. Covered: the
 * command, stdin and file change approvals, a file change too large to show, a permissions request,
 * the decisions a server lists, questions as a form, a secret question, an MCP tool-call approval,
 * an MCP server's form, a request nobody resolves until the desk closes, a
 * request the app-server resolves first, an answer after the app-server is gone, no desk, and the
 * Connector's declaration.
 *
 * Run: pnpm smoke:codex-prompts
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentPrompt, CotalEndpoint, EpPrincipalServeContext, PromptState, PromptsOutput } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import type { ServerRequest, ThreadItem } from "../src/app-server.js";
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

// ---- a file change too large to show ------------------------------------------------------------
{
  const w = world();
  // A deleted file's diff is its whole content, so deleting a 300 KB file passes the desk's limit.
  const changes = [{ path: "/work/big.txt", kind: { type: "delete" }, diff: "x".repeat(300 * 1024) }];
  w.prompts.itemStarted({ type: "fileChange", id: "call_big", changes, status: "inProgress" });
  const req = request("item/fileChange/requestApproval", { itemId: "call_big" });
  const id = hold(w, req);
  const c = id ? read(w, id).content : undefined;
  check("a file change too large to show still opens a prompt, with its input omitted",
    (c?.subject as { input?: { kind: string } } | undefined)?.input?.kind === "omitted", { id, warnings: w.warnings });
  check("and it offers only the decisions that refuse", isDeepStrictEqual(c?.options.map((o) => o.id), ["decline", "cancel"]), c?.options);
  if (id) await answer(w, id, "cancel");
  check("a remote answer reaches Codex as its decision", isDeepStrictEqual(w.written.at(-1), { id: req.id, result: { decision: "cancel" } }), w.written);
}

// ---- a permissions request ----------------------------------------------------------------------
{
  const w = world();
  // The shape codex 0.162 sends for its `request_permissions` tool: a plain path in both the legacy
  // list and the entries, a glob in the entries alone.
  const fileSystem = {
    read: null, write: ["/w/out"],
    entries: [{ access: "write", path: { type: "path", path: "/w/out" } }, { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } }],
  };
  const ask = (itemId: string) => request("item/permissions/requestApproval", {
    itemId, environmentId: "local", startedAtMs: 1, cwd: "/w", reason: "fetch a page", permissions: { network: { enabled: true }, fileSystem },
  });
  const req = ask("toolu_1");
  const id = hold(w, req);
  const c = id ? read(w, id).content : undefined;
  check("a permissions request opens a permission prompt for request_permissions with what it asks for",
    c?.kind === "permission" && c.title === "Give Codex more permissions?" && c.source?.toolCallId === "toolu_1" &&
      isDeepStrictEqual(c.subject, { type: "tool", name: "request_permissions", input: { kind: "shown", value: { permissions: { network: { enabled: true }, fileSystem } } }, cwd: "/w" }), c);
  check("it shows the reason and says what is asked", c?.body?.text === "fetch a page\n\nCodex asks for network access and write access to /w/out, /w/out/**.", c?.body);
  check("it offers the turn, the session or nothing", isDeepStrictEqual(c?.options.map((o) => [o.id, o.effect]), [["accept", "proceed"], ["accept-for-session", "proceed"], ["decline", "refuse"]]), c?.options);
  if (id) await answer(w, id, "accept");
  check("allowing grants what it asked for, for the turn",
    isDeepStrictEqual(w.written.at(-1), { id: req.id, result: { permissions: { network: { enabled: true }, fileSystem }, scope: "turn" } }), w.written);
  const session = ask("toolu_2");
  const sessionId = hold(w, session);
  if (sessionId) await answer(w, sessionId, "accept-for-session");
  check("allowing for the session grants it for the session", isDeepStrictEqual((w.written.at(-1)?.result as { scope?: string } | undefined)?.scope, "session"), w.written.at(-1));
  const denied = ask("toolu_3");
  const deniedId = hold(w, denied);
  if (deniedId) await answer(w, deniedId, "decline");
  check("a deny grants nothing", isDeepStrictEqual(w.written.at(-1), { id: denied.id, result: { permissions: {}, scope: "turn" } }), w.written.at(-1));
  const left = ask("toolu_4");
  hold(w, left);
  w.desk.close();
  check("one still waiting when the desk closes grants nothing", isDeepStrictEqual(w.written.at(-1), { id: left.id, result: { permissions: {}, scope: "turn" } }), w.written.at(-1));
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

// ---- MCP elicitations --------------------------------------------------------------------------
const ELICIT = "mcpServer/elicitation/request";
const NOTHING = { content: null, _meta: null };
const mcpCall = (id: string, tool = "hello"): ThreadItem => ({ type: "mcpToolCall", id, server: "elicit", tool, status: "inProgress", arguments: { who: "Ada" } });
// The tool-call approval codex 0.162 sends for an MCP server's tool: an empty form, its kind in `_meta`.
const approveCall = (persist?: unknown) => request(ELICIT, {
  serverName: "elicit", mode: "form", message: 'Allow the elicit MCP server to run tool "hello"?', requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call", ...(persist !== undefined ? { persist } : {}), tool_description: "Say hello.", tool_params: { who: "Ada" }, tool_params_display: [] },
});
const optionsOf = (w: World, id: string | undefined) => (id ? read(w, id).content.options.map((o) => o.id) : undefined);
{
  const w = world();
  w.prompts.itemStarted(mcpCall("toolu_m1"));
  const req = approveCall(["session", "always"]);
  const id = hold(w, req);
  const c = id ? read(w, id).content : undefined;
  check("an MCP tool-call approval opens a permission prompt for the running call",
    c?.kind === "permission" && c.title === 'Allow the elicit MCP server to run tool "hello"?' && c.source?.toolCallId === "toolu_m1" && c.body?.text === "Say hello." &&
      isDeepStrictEqual(c.subject, { type: "tool", name: "hello", input: { kind: "shown", value: { who: "Ada" } }, server: "elicit" }), c);
  check("it offers allow, the persistence Codex lists, deny and cancel",
    isDeepStrictEqual(c?.options.map((o) => [o.id, o.effect, o.persists !== undefined]),
      [["accept", "proceed", false], ["accept-for-session", "proceed", true], ["accept-always", "proceed", true], ["decline", "refuse", false], ["cancel", "cancel", false]]), c?.options);
  if (id) await answer(w, id, "accept");
  check("allowing accepts the call once", isDeepStrictEqual(w.written.at(-1), { id: req.id, result: { action: "accept", content: {}, _meta: null } }), w.written.at(-1));
  for (const [option, persist] of [["accept-for-session", "session"], ["accept-always", "always"]] as const) {
    const r = approveCall(["session", "always"]);
    const rid = hold(w, r);
    if (rid) await answer(w, rid, option);
    check(`${option} asks Codex to keep the approval for ${persist}`, isDeepStrictEqual(w.written.at(-1), { id: r.id, result: { action: "accept", content: {}, _meta: { persist } } }), w.written.at(-1));
  }
  for (const action of ["decline", "cancel"]) {
    const r = approveCall(["session", "always"]);
    const rid = hold(w, r);
    if (rid) await answer(w, rid, action);
    check(`${action} is written as Codex's ${action}`, isDeepStrictEqual(w.written.at(-1), { id: r.id, result: { action, ...NOTHING } }), w.written.at(-1));
  }
  check("only the persistence Codex lists is offered", isDeepStrictEqual(optionsOf(w, hold(w, approveCall("session"))), ["accept", "accept-for-session", "decline", "cancel"]));
  check("with none listed, nothing persists", isDeepStrictEqual(optionsOf(w, hold(w, approveCall())), ["accept", "decline", "cancel"]));
  w.prompts.itemStarted(mcpCall("toolu_m2"));
  const twoId = hold(w, approveCall());
  const two = twoId ? read(w, twoId).content : undefined;
  check("with two calls running on the server, the prompt names neither and keeps Codex's question",
    two !== undefined && two.subject === undefined && two.source?.toolCallId === undefined && two.title === 'Allow the elicit MCP server to run tool "hello"?', two);
}
{
  const w = world();
  w.prompts.itemStarted(mcpCall("toolu_f1", "pick_color"));
  const requestedSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["color"],
    properties: {
      color: { type: "string", title: "Color", enum: ["red", "green"], enumNames: ["Red", "Green"] },
      shade: { type: "integer", title: "Shade", minimum: 1, maximum: 9, default: 5 },
      bold: { type: "boolean", title: "Bold", default: false },
    },
  };
  const form = (message = "Which color should the banner be?") => request(ELICIT, { serverName: "elicit", mode: "form", _meta: null, message, requestedSchema });
  const req = form();
  const id = hold(w, req);
  const c = id ? read(w, id).content : undefined;
  check("an MCP server's form opens a form prompt with its fields, for the running call, naming the server",
    c?.kind === "form" && c.title === "Which color should the banner be?" && c.source?.toolCallId === "toolu_f1" && c.body?.text === "Asked by the elicit MCP server." &&
      isDeepStrictEqual(c.form?.schema, {
        type: "object", required: ["color"],
        properties: {
          color: { type: "string", title: "Color", oneOf: [{ const: "red", title: "Red" }, { const: "green", title: "Green" }] },
          shade: { type: "integer", title: "Shade", minimum: 1, maximum: 9, default: 5 },
          bold: { type: "boolean", title: "Bold", default: false },
        },
      }), c);
  check("it offers submit, decline and cancel", isDeepStrictEqual(c?.options.map((o) => [o.id, o.effect, o.form]), [["submit", "proceed", "required"], ["decline", "refuse", undefined], ["cancel", "cancel", undefined]]), c?.options);
  if (id) await answer(w, id, "submit", { color: "green", shade: 7, bold: true });
  check("submitted values are written as the elicitation's content",
    isDeepStrictEqual(w.written.at(-1), { id: req.id, result: { action: "accept", content: { color: "green", shade: 7, bold: true }, _meta: null } }), w.written.at(-1));
  const message = `First line\n${"x".repeat(300)}`;
  const longId = hold(w, form(message));
  const long = longId ? read(w, longId).content : undefined;
  check("a message longer than a title keeps its full text in the body",
    long !== undefined && !long.title.includes("\n") && long.title.length <= 200 && long.body?.text === `${message}\n\nAsked by the elicit MCP server.`, long);
  const nested = request(ELICIT, { serverName: "elicit", mode: "form", _meta: null, message: "?", requestedSchema: { type: "object", properties: { a: { type: "object", properties: {} } } } });
  check("a form outside the desk's form profile is not held, and the host says so", w.prompts.hold(nested) === false && w.warnings.some((m) => m.includes(ELICIT)), w.warnings);
  check("a url elicitation is not held", w.prompts.hold(request(ELICIT, { serverName: "elicit", mode: "url", _meta: null, message: "Sign in", url: "https://example.com", elicitationId: "e1" })) === false);
  check("an OpenAI form is not held", w.prompts.hold(request(ELICIT, { serverName: "elicit", mode: "openai/form", _meta: null, message: "?", requestedSchema: {} })) === false);
  const left = form();
  hold(w, left);
  w.desk.close();
  check("one still waiting when the desk closes is cancelled", isDeepStrictEqual(w.written.at(-1), { id: left.id, result: { action: "cancel", ...NOTHING } }), w.written.at(-1));
}

// ---- requests the module leaves to the driver --------------------------------------------------
{
  const w = world({ served: false });
  check("with no desk served, nothing is held", w.prompts.hold(request("item/commandExecution/requestApproval", { itemId: "c" })) === false);
  const v = world();
  check("a request kind the module does not know is not held", v.prompts.hold(request("applyPatchApproval", { itemId: "c" })) === false);
  check("a permissions request that asks for nothing is not held", v.prompts.hold(request("item/permissions/requestApproval", { itemId: "c", permissions: { network: null, fileSystem: null } })) === false);
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
