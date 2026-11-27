/**
 * Hermes's clarify questions on the agent's prompt desk, through the shipped `createHermesClarify`
 * on connector-core's real desk, fed the `clarify` and `clarify_end` frames the plugin sends
 * (plugin/cotal/clarify.py), and the plugin half driven by plugin-clarify.probe.py.
 *
 * Run: pnpm smoke:hermes-clarify
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { AgentPrompt, CotalEndpoint, EpPrincipalServeContext, PromptState, PromptsOutput } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import { DISMISSED, createHermesClarify, type HermesClarify } from "../src/clarify.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface World {
  desk: ServedPromptDesk;
  clarify: HermesClarify;
  sent: { id: string; response: string }[];
  warned: string[];
  connected: boolean;
}

function world(opts: { served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const desk = createPromptDesk(ep, () => {});
  const w = { desk, sent: [], warned: [], connected: true } as unknown as World;
  w.clarify = createHermesClarify({
    desk: () => (opts.served === false ? undefined : desk),
    send: (answer) => (w.connected ? (w.sent.push(answer), true) : false),
    warn: (msg) => void w.warned.push(msg),
  });
  return w;
}

let ids = 0;
/** One `clarify` frame as the plugin sends it; returns its id. */
function ask(w: World, over: Record<string, unknown> = {}): string {
  const id = `cl${++ids}`;
  w.clarify.request({ t: "clarify", id, session: "agent:main:cotal:dm:operator", question: "Which color?", choices: ["red", "blue"], multiple: false, timeoutMs: 60_000, ...over });
  return id;
}
const ended = (w: World, id: string, resolved: boolean): void => w.clarify.ended({ t: "clarify_end", id, resolved });

function call(w: World, command: string, args: Record<string, unknown>): unknown {
  const def = w.desk.handlers().find((d) => d.command === command)!;
  return def.handler({
    endpoint: "agent", principal: { owner: "u_alice", actor: "hermes", uid: "a".repeat(26), runtimeId: "r".repeat(16) },
    caller: { owner: "u_alice", actor: "web", uid: "w".repeat(26) }, authority: "owner",
    request: { v: 1, id: "req", command, args }, receivedAtMonotonicMs: performance.now(),
    replyFits: () => true, signal: new AbortController().signal,
  } as unknown as EpPrincipalServeContext);
}
const list = (w: World) => call(w, "prompts", {}) as PromptsOutput;
const asking = (w: World): string[] => list(w).open.filter((s) => s.state.kind === "open").map((s) => s.id);
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
const stateOf = (w: World, id: string): PromptState | undefined => [...list(w).open, ...list(w).closed].find((s) => s.id === id)?.state;
const closedAs = (s: PromptState | undefined, kind: string) => s?.kind === "closed" && s.outcome.kind === kind;
async function answer(w: World, id: string, option: string, values?: Record<string, unknown>): Promise<void> {
  void call(w, "prompt-answer", { id, digest: read(w, id).digest, option, ...(values ? { values } : {}) });
  await flush();
}
/** The refusal an answer meets, or "" when it was accepted. */
function refusalOf(w: World, id: string, option: string, values: Record<string, unknown>): string {
  try {
    void call(w, "prompt-answer", { id, digest: read(w, id).digest, option, values });
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
const schemaOf = (p: AgentPrompt) => (p.content.form as { schema: { properties: Record<string, Record<string, unknown>>; required?: string[] } }).schema;

console.log("Hermes clarify questions on the prompt desk");
{
  const w = world();
  const cid = ask(w);
  const [id] = asking(w);
  const prompt = read(w, id!);
  check("a question opens one question prompt titled with it",
    prompt.content.kind === "question" && prompt.content.title === "Which color?" && isDeepStrictEqual(prompt.content.source, { harness: "hermes" }), prompt.content);
  const schema = schemaOf(prompt);
  check("its form offers Hermes's choices with an answer of one's own beside them",
    isDeepStrictEqual(schema.properties.answer, { type: "string", title: "Answer", description: "Which color?", oneOf: [{ const: "red", title: "red" }, { const: "blue", title: "blue" }] }) &&
      schema.properties.answer__other?.type === "string" && schema.required === undefined, schema);
  check("it offers Submit and Dismiss", prompt.content.options.map((o) => `${o.id}:${o.effect}`).join() === "submit:proceed,dismiss:cancel", prompt.content.options);
  check("it stays open a little longer than Hermes waits", Date.parse(prompt.expiresAt) - Date.parse(prompt.openedAt) === 65_000, [prompt.openedAt, prompt.expiresAt]);
  await answer(w, id!, "submit", { answer: "blue" });
  check("the choice goes to Hermes as the reply", isDeepStrictEqual(w.sent, [{ id: cid, response: "blue" }]), w.sent);
  check("and waits for Hermes to take it", stateOf(w, id!)?.kind === "sent", stateOf(w, id!));
  ended(w, cid, true);
  await flush();
  check("Hermes taking it confirms the answer", closedAs(stateOf(w, id!), "answered"), stateOf(w, id!));

  const own = ask(w);
  await answer(w, asking(w)[0]!, "submit", { answer__other: "  green  " });
  check("an answer of one's own goes as typed", w.sent.at(-1)?.id === own && w.sent.at(-1)?.response === "green", w.sent.at(-1));

  const before = w.sent.length;
  ask(w);
  const empty = asking(w)[0]!;
  const refused = refusalOf(w, empty, "submit", {});
  await flush();
  check("a form with no answer is refused and sends nothing",
    /pick a choice or give an answer of your own/.test(refused) && w.sent.length === before && stateOf(w, empty)?.kind === "open", refused);
  await answer(w, empty, "dismiss");
  check("dismissing tells Hermes the user did not answer", w.sent.at(-1)?.response === DISMISSED, w.sent.at(-1));
}
{
  const w = world();
  const cid = ask(w, { multiple: true, choices: ["staging", "prod", "dev"] });
  const id = asking(w)[0]!;
  const answerField = schemaOf(read(w, id)).properties.answer;
  check("a multiple choice takes any number of the choices", answerField?.type === "array" && isDeepStrictEqual((answerField.items as { anyOf: unknown[] }).anyOf.length, 3), answerField);
  await answer(w, id, "submit", { answer: ["staging", "prod"] });
  check("and goes to Hermes as a JSON array of the labels", w.sent.at(-1)?.id === cid && w.sent.at(-1)?.response === '["staging","prod"]', w.sent.at(-1));

  const open = ask(w, { choices: [], question: "What should the release be called?" });
  const freeId = asking(w)[0]!;
  const free = schemaOf(read(w, freeId));
  check("a question with no choices takes free text, required",
    free.properties.answer?.type === "string" && free.properties.answer.oneOf === undefined && free.properties.answer__other === undefined && isDeepStrictEqual(free.required, ["answer"]), free);
  await answer(w, freeId, "submit", { answer: " Aurora " });
  check("and goes as typed", w.sent.at(-1)?.id === open && w.sent.at(-1)?.response === "Aurora", w.sent.at(-1));
  ended(w, open, false);
  await flush();
  check("an answer Hermes no longer waited for closes undelivered", closedAs(stateOf(w, freeId), "undelivered"), stateOf(w, freeId));

  const gone = ask(w);
  const goneId = asking(w)[0]!;
  ended(w, gone, false);
  check("Hermes ending its wait before an answer withdraws the prompt and sends nothing",
    closedAs(stateOf(w, goneId), "withdrawn") && !w.sent.some((s) => s.id === gone), stateOf(w, goneId));

  w.connected = false;
  ask(w);
  const lost = asking(w)[0]!;
  await answer(w, lost, "submit", { answer: "red" });
  check("an answer no adapter takes closes undelivered", closedAs(stateOf(w, lost), "undelivered"), stateOf(w, lost));
}
{
  const w = world({ served: false });
  const cid = ask(w);
  check("an unserved desk answers Hermes at once with the cause, so the model asks in its reply",
    w.sent.length === 1 && w.sent[0]!.id === cid && /does not serve its prompt desk/.test(w.sent[0]!.response) && /Ask it in your reply instead/.test(w.sent[0]!.response), w.sent);

  const full = world();
  for (let i = 0; i < 32; i++) ask(full);
  const over = ask(full);
  check("a full desk answers at once with the cause", full.sent.length === 1 && full.sent[0]!.id === over && /Cotal could not put this question/.test(full.sent[0]!.response), full.sent);

  const bad = world();
  bad.clarify.request({ t: "clarify", id: "x", question: "Pick", choices: ["a", 3], timeoutMs: 1000 });
  bad.clarify.request({ t: "clarify", id: "y", question: "Pick", choices: ["a"] });
  check("a malformed frame opens nothing and is warned", asking(bad).length === 0 && bad.sent.length === 0 && bad.warned.length === 2, bad.warned);
}

console.log("the plugin half");
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the plugin half cannot be verified");
const probe = fileURLToPath(new URL("./plugin-clarify.probe.py", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
const res = spawnSync(python, ["-I", probe, plugin], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH } });
const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
check("the probe ran", res.status === 0 && line !== undefined, res.stderr || res.stdout);
type Frame = Record<string, unknown>;
const out = (line ? JSON.parse(line.slice(7)) : {}) as Record<string, { success?: boolean; error?: string; frames?: Frame[]; base?: unknown[]; resolved?: unknown[] }>;
const op = out.operator ?? {};
check("a question in the operator chat goes to the sidecar, and Hermes is told it was sent",
  op.success === true && isDeepStrictEqual(op.frames, [{ t: "clarify", id: "c1", session: "s-op", question: "Which color?", choices: ["red", "blue"], multiple: false, timeoutMs: 120_000 }]) && op.base?.length === 0, op);
check("a multiple choice is marked so, from Hermes's own entry", out.multi?.frames?.[0]?.multiple === true, out.multi);
check("a question in a peer's chat keeps Hermes's own text prompt", out.peer?.success === true && out.peer.frames?.length === 0 && out.peer.base?.length === 1, out.peer);
check("with no sidecar connected Hermes is told it was not sent", out.offline?.success === false && /not connected/.test(out.offline.error ?? ""), out.offline);
check("the owner's answer resolves Hermes's wait and reports it taken",
  isDeepStrictEqual(out.answered?.resolved, [["c1", "blue"]]) && isDeepStrictEqual(out.answered?.frames, [{ t: "clarify_end", id: "c1", resolved: true }]), out.answered);
check("an answer Hermes no longer waits for is reported not taken", isDeepStrictEqual(out.late?.frames, [{ t: "clarify_end", id: "c2", resolved: false }]), out.late);
check("an answer to no open question does nothing", out.unknown?.resolved?.length === 0 && out.unknown.frames?.length === 0, out.unknown);
check("the end of a turn in another chat ends no question", out.peerTurnDone?.frames?.length === 0, out.peerTurnDone);
check("the end of the operator chat's turn reports its open questions ended",
  isDeepStrictEqual(out.turnDone?.frames, [{ t: "clarify_end", id: "cm", resolved: false }, { t: "clarify_end", id: "c3", resolved: false }]), out.turnDone);
check("an answer after the turn ended resolves nothing", out.afterTurn?.resolved?.length === 0 && out.afterTurn.frames?.length === 0, out.afterTurn);

finish();
