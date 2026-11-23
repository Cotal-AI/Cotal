/**
 * OpenCode's permission asks and questions on the agent's prompt desk (SPEC 13.22), with no broker.
 *
 * Events in the shapes each line emits (2.x as measured on 2.0.24, 1.x as `@opencode-ai/sdk`'s v2
 * types name them) drive the shipped ask handlers against the shipped prompt desk. An answer is a
 * `prompt-answer` call on the desk's own handler, and OpenCode's HTTP API is a recorder that answers
 * as told. Covered: the prompt each ask opens, every reply and its request, an ask OpenCode does not
 * hold, a reply given at OpenCode's own dialog, the turn end, the sessions served, a form the
 * profile cannot carry, no desk, and the connector's `prompts` declaration.
 *
 * Run: pnpm smoke:opencode-prompts
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentPrompt, CotalEndpoint, EpPrincipalServeContext, PromptState, PromptsOutput } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import { opencode1Asks, opencode2Asks, type OpenCodeAsks } from "../src/prompt-asks.js";
import { opencodeConnector } from "../src/extension.js";

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const SESSION = "ses_main";
interface World { desk: ServedPromptDesk; asks: OpenCodeAsks; sent: { path: string; method: string; body?: unknown }[]; holds: boolean; warnings: string[] }

function world(line: 1 | 2, opts: { served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const desk = createPromptDesk(ep, () => {});
  const w = { desk, sent: [], holds: true, warnings: [] } as unknown as World;
  const make = line === 1 ? opencode1Asks : opencode2Asks;
  w.asks = make({
    desk: () => (opts.served === false ? undefined : desk),
    warn: (m) => w.warnings.push(m),
    session: () => SESSION,
    send: async (path, init) => {
      w.sent.push({ path, method: String(init.method), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return w.holds;
    },
  });
  return w;
}

function call(w: World, command: string, args: Record<string, unknown>): unknown {
  const def = w.desk.handlers().find((d) => d.command === command)!;
  return def.handler({
    endpoint: "agent", principal: { owner: "u_alice", actor: "coder", uid: "a".repeat(26), runtimeId: "r".repeat(16) },
    caller: { owner: "u_alice", actor: "web", uid: "w".repeat(26) }, authority: "owner",
    request: { v: 1, id: "req", command, args }, receivedAtMonotonicMs: performance.now(),
    replyFits: () => true, signal: new AbortController().signal,
  } as unknown as EpPrincipalServeContext);
}
const list = (w: World) => call(w, "prompts", {}) as PromptsOutput;
const only = (w: World) => list(w).open[0]!;
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
const stateOf = (w: World, id: string): PromptState | undefined => [...list(w).open, ...list(w).closed].find((s) => s.id === id)?.state;
async function answer(w: World, id: string, option: string, extra: { note?: string; values?: Record<string, unknown> } = {}) {
  const p = read(w, id);
  const out = (await call(w, "prompt-answer", { id, digest: p.digest, option, ...extra })) as { state: PromptState };
  await flush();
  return out.state;
}
const closedAs = (s: PromptState | undefined, outcome: Record<string, unknown>) =>
  s?.kind === "closed" && Object.entries(outcome).every(([k, v]) => isDeepStrictEqual((s.outcome as Record<string, unknown>)[k], v));

// The permission request and the question form as OpenCode 2.0.24 sent them.
const permission2 = (id = "per_1", sessionID = SESSION) => ({
  id, sessionID, action: "shell", resources: ["echo perm-check"], save: ["echo *"],
  source: { type: "tool", messageID: "msg_1", id: "call_1" },
});
const questionForm = (id = "frm_1") => ({
  form: {
    id, sessionID: SESSION, title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_2", id: "call_2" } },
    fields: [{ key: "q0", title: "Color", description: "Which color do you prefer, red or blue?", type: "string", custom: true,
      options: [{ value: "Red", label: "Red", description: "I prefer red" }, { value: "Blue", label: "Blue", description: "I prefer blue" }] }],
  },
});

console.log("\nOpenCode 2.x: a permission ask");
{
  const w = world(2);
  w.asks.event("permission.asked", permission2());
  const p = read(w, only(w).id);
  check("it opens a permission prompt naming what the call would touch, with once, always and reject",
    isDeepStrictEqual(p.content, {
      kind: "permission", title: "Allow shell?", body: { format: "text", text: "echo perm-check" },
      subject: { type: "ai.cotal.opencode.permission", data: { action: "shell", patterns: ["echo perm-check"] } },
      options: [
        { id: "once", label: "Allow once", effect: "proceed" },
        { id: "always", label: "Allow always", effect: "proceed", persists: "Saves an allow rule for this project: shell echo *" },
        { id: "reject", label: "Reject", effect: "refuse", note: "optional" },
      ],
      source: { harness: "opencode", toolCallId: "call_1" },
    }), p.content);
  const state = await answer(w, p.id, "once");
  check("allow once replies once on the session's permission route and closes answered",
    isDeepStrictEqual(w.sent, [{ path: "/api/session/ses_main/permission/per_1/reply", method: "POST", body: { decision: "once" } }]) && closedAs(state, { kind: "answered" }),
    { sent: w.sent, state });
  w.asks.event("permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "once" });
  check("OpenCode's reply event for an answer given here changes nothing", closedAs(stateOf(w, p.id), { kind: "answered" }));
}
{
  const w = world(2);
  w.asks.event("permission.asked", permission2());
  const state = await answer(w, only(w).id, "reject", { note: "use ls instead" });
  check("reject carries its note to OpenCode as the message",
    isDeepStrictEqual(w.sent[0]?.body, { decision: "reject", message: "use ls instead" }) && closedAs(state, { kind: "answered" }), { sent: w.sent, state });
}
{
  const w = world(2);
  w.holds = false;
  w.asks.event("permission.asked", permission2());
  const state = await answer(w, only(w).id, "always");
  check("a reply OpenCode does not hold closes undelivered", closedAs(state, { kind: "undelivered" }), state);
}
{
  const w = world(2);
  w.asks.event("permission.asked", permission2());
  const id = only(w).id;
  w.asks.event("permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "reject" });
  await flush();
  check("a reject given at OpenCode's own dialog closes the prompt as answered there, refused",
    closedAs(stateOf(w, id), { kind: "local", seen: { tie: "prompt", effect: "refuse" } }) && w.sent.length === 0, stateOf(w, id));
  w.asks.event("permission.asked", permission2("per_2"));
  const second = only(w).id;
  w.asks.turnEnded();
  await flush();
  check("the turn's end withdraws a prompt nobody answered", closedAs(stateOf(w, second), { kind: "withdrawn" }), stateOf(w, second));
}
{
  const w = world(2);
  w.asks.event("permission.asked", permission2("per_other", "ses_other"));
  check("another session's ask opens nothing", list(w).open.length === 0);
  w.asks.event("session.created", { sessionID: "ses_child", parentID: SESSION });
  w.asks.event("permission.asked", permission2("per_child", "ses_child"));
  const p = read(w, only(w).id);
  check("a subagent session's ask opens a prompt scoped to that session",
    isDeepStrictEqual(p.content.source, { harness: "opencode", scope: "ses_child", toolCallId: "call_1" }), p.content.source);
}

console.log("\nOpenCode 2.x: a question");
{
  const w = world(2);
  w.asks.event("form.created", questionForm());
  const p = read(w, only(w).id);
  check("the question tool's form opens a question prompt whose choices are a single choice, with submit and dismiss",
    isDeepStrictEqual(p.content, {
      kind: "question", title: "Questions",
      options: [{ id: "submit", label: "Submit", effect: "proceed", form: "required" }, { id: "dismiss", label: "Dismiss", effect: "cancel" }],
      form: { schema: { type: "object", properties: { q0: { type: "string", title: "Color", description: "Which color do you prefer, red or blue?",
        oneOf: [{ const: "Red", title: "Red", description: "I prefer red" }, { const: "Blue", title: "Blue", description: "I prefer blue" }] } } } },
      source: { harness: "opencode", toolCallId: "call_2" },
    }), p.content);
  const state = await answer(w, p.id, "submit", { values: { q0: "Blue" } });
  check("submit replies with the answer per field key and closes answered",
    isDeepStrictEqual(w.sent, [{ path: "/api/session/ses_main/form/frm_1/reply", method: "POST", body: { answer: { q0: "Blue" } } }]) && closedAs(state, { kind: "answered" }),
    { sent: w.sent, state });
}
{
  const w = world(2);
  w.asks.event("form.created", questionForm());
  const state = await answer(w, only(w).id, "dismiss");
  check("dismiss cancels the form", isDeepStrictEqual(w.sent, [{ path: "/api/session/ses_main/form/frm_1", method: "DELETE" }]) && closedAs(state, { kind: "answered" }), { sent: w.sent, state });
  w.asks.event("form.created", questionForm("frm_2"));
  const id = only(w).id;
  w.asks.event("form.cancelled", { id: "frm_2", sessionID: SESSION });
  await flush();
  check("a form dismissed at OpenCode's own dialog closes as answered there, cancelled",
    closedAs(stateOf(w, id), { kind: "local", seen: { tie: "prompt", effect: "cancel" } }), stateOf(w, id));
  const form = questionForm("frm_3");
  form.form.fields.push({ key: "link", type: "external", url: "https://example.test" } as never);
  w.asks.event("form.created", form);
  check("a form with a field the profile cannot carry is left to OpenCode's dialog, and says why",
    list(w).open.length === 0 && w.warnings.some((m) => m.includes("frm_3") && m.includes("external")), w.warnings);
}

console.log("\nOpenCode 1.x");
{
  const w = world(1);
  w.asks.event("permission.asked", { id: "per_1", sessionID: SESSION, permission: "bash", patterns: ["git push"], metadata: {}, always: ["git push *"], tool: { messageID: "msg_1", callID: "call_1" } });
  const p = read(w, only(w).id);
  check("a permission ask says always lasts for the OpenCode session",
    p.content.title === "Allow bash?" && p.content.options[1]?.persists === "Allows bash git push * for the rest of this OpenCode session", p.content);
  const state = await answer(w, p.id, "always");
  check("allow always replies always on the permission route",
    isDeepStrictEqual(w.sent, [{ path: "/permission/per_1/reply", method: "POST", body: { reply: "always" } }]) && closedAs(state, { kind: "answered" }), { sent: w.sent, state });
}
{
  const w = world(1);
  w.asks.event("question.asked", {
    id: "que_1", sessionID: SESSION, tool: { messageID: "msg_1", callID: "call_9" },
    questions: [
      { question: "Which branch?", header: "Branch", options: [{ label: "main", description: "the default" }, { label: "dev", description: "work in progress" }] },
      { question: "Which checks?", header: "Checks", multiple: true, options: [{ label: "lint", description: "" }, { label: "test", description: "" }] },
    ],
  });
  const p = read(w, only(w).id);
  const schema = p.content.form?.schema as { properties: Record<string, { type: string; items?: unknown }> };
  check("a question request opens one question prompt, a field per question, a multiple one as a multiple choice",
    p.content.kind === "question" && p.content.title === "Questions" && schema.properties.q0?.type === "string"
      && isDeepStrictEqual(schema.properties.q1, { type: "array", title: "Checks", description: "Which checks?", items: { anyOf: [{ const: "lint", title: "lint" }, { const: "test", title: "test" }] } }),
    p.content);
  const state = await answer(w, p.id, "submit", { values: { q0: "dev", q1: ["lint", "test"] } });
  check("submit replies with one list of labels per question",
    isDeepStrictEqual(w.sent, [{ path: "/question/que_1/reply", method: "POST", body: { answers: [["dev"], ["lint", "test"]] } }]) && closedAs(state, { kind: "answered" }), { sent: w.sent, state });
  w.asks.event("question.asked", { id: "que_2", sessionID: SESSION, questions: [{ question: "Go on?", header: "Go", options: [] }] });
  await answer(w, only(w).id, "dismiss");
  check("dismiss rejects the question", isDeepStrictEqual(w.sent[1], { path: "/question/que_2/reject", method: "POST", body: {} }), w.sent);
  w.asks.event("question.asked", { id: "que_3", sessionID: SESSION, questions: [{ question: "Go on?", header: "Go", options: [] }] });
  const id = only(w).id;
  w.asks.event("question.replied", { sessionID: SESSION, requestID: "que_3", answers: [["yes"]] });
  await flush();
  check("a question answered at OpenCode's own dialog closes as answered there", closedAs(stateOf(w, id), { kind: "local", seen: { tie: "prompt", effect: "proceed" } }), stateOf(w, id));
}
{
  const w = world(1, { served: false });
  w.asks.event("permission.asked", { id: "per_1", sessionID: SESSION, permission: "bash", patterns: ["ls"], metadata: {}, always: [] });
  check("with no desk served, an ask opens nothing", list(w).open.length === 0);
}

check("the OpenCode connector declares that its sessions serve prompts", opencodeConnector.prompts === true);
finish();
