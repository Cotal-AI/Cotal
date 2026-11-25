/**
 * A Hermes seat launched with `askPermissions` puts each of Hermes's command approvals behind the
 * agent's prompt desk, through the shipped `createHermesApprovals` on connector-core's real desk,
 * fed the `approval` and `approval_end` frames the plugin sends (plugin/cotal/approvals.py).
 *
 * Covered: the prompt's content and the choices Hermes offers; an answer goes to the gateway and
 * Hermes applying it confirms it; a deny carries the owner's note; a session's answers go in the
 * order its prompts opened, and another session's do not wait; Hermes's timeout or a stop withdraws
 * a prompt and sends nothing; an unserved or full desk denies at once with the cause; a command over
 * the size limit shows by size with only Deny; a malformed frame is ignored; the connector declares
 * the field, carries it to the seat and keeps the managed profile's approvals manual for it.
 *
 * Run: pnpm smoke:hermes-approvals
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, type AgentPrompt, type CotalEndpoint, type EpPrincipalServeContext, type PromptState, type PromptsOutput } from "@cotal-ai/core";
import type { AgentConfig } from "@cotal-ai/connector-core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import { createHermesApprovals, type HermesApprovals } from "../src/approvals.js";
import { hermesConnector } from "../src/extension.js";
import { setupProfile } from "../src/launch.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface World {
  desk: ServedPromptDesk;
  approvals: HermesApprovals;
  /** The answers sent to the gateway, in order. */
  sent: Record<string, unknown>[];
  warned: string[];
  /** Whether an adapter takes the answer. */
  connected: boolean;
}

function world(opts: { served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const desk = createPromptDesk(ep, () => {});
  const w = { desk, sent: [], warned: [], connected: true } as unknown as World;
  w.approvals = createHermesApprovals({
    desk: () => (opts.served === false ? undefined : desk),
    send: (answer) => (w.connected ? (w.sent.push(answer), true) : false),
    warn: (msg) => void w.warned.push(msg),
  });
  return w;
}

let ids = 0;
/** One `approval` frame as the plugin sends it; returns its id. */
function ask(w: World, over: Record<string, unknown> = {}): string {
  const id = `ap${++ids}`;
  w.approvals.request({
    t: "approval", id, session: "agent:main:cotal:dm:operator", command: "rm -rf build", description: "recursive delete",
    tool: "terminal", toolCallId: `call_${ids}`, choices: ["once", "session", "always", "deny"], note: true, timeoutMs: 60_000, ...over,
  });
  return id;
}
const ended = (w: World, outcome: string, session = "agent:main:cotal:dm:operator"): void => w.approvals.ended({ t: "approval_end", session, outcome });

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
/** The prompts still waiting for an answer, oldest first. */
const asking = (w: World): string[] => list(w).open.filter((s) => s.state.kind === "open").map((s) => s.id);
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
const stateOf = (w: World, id: string): PromptState | undefined => [...list(w).open, ...list(w).closed].find((s) => s.id === id)?.state;
const closedAs = (s: PromptState | undefined, kind: string) => s?.kind === "closed" && s.outcome.kind === kind;
async function answer(w: World, id: string, option: string, note?: string): Promise<void> {
  void call(w, "prompt-answer", { id, digest: read(w, id).digest, option, ...(note ? { note } : {}) });
  await flush();
}

console.log("Hermes approvals behind the prompt desk");
{
  const w = world();
  ask(w);
  const [id] = asking(w);
  const prompt = read(w, id!);
  check("an approval opens one prompt naming the tool, the command, Hermes's reason and the call",
    prompt.content.kind === "permission" && prompt.content.title === "Allow terminal?" &&
    isDeepStrictEqual(prompt.content.body, { format: "text", text: "recursive delete" }) &&
    isDeepStrictEqual(prompt.content.subject, { type: "tool", name: "terminal", input: { kind: "shown", value: { command: "rm -rf build" } } }) &&
    isDeepStrictEqual(prompt.content.source, { harness: "hermes", toolCallId: `call_${ids}` }), prompt.content);
  check("it offers Hermes's choices, the lasting ones marked, and a Deny that takes a note",
    prompt.content.options.map((o) => `${o.id}:${o.effect}:${o.persists ? "persists" : "-"}:${o.note ?? "-"}`).join() ===
      "once:proceed:-:-,session:proceed:persists:-,always:proceed:persists:-,deny:refuse:-:optional", prompt.content.options);
  check("it stays open a little longer than Hermes waits", Date.parse(prompt.expiresAt) - Date.parse(prompt.openedAt) === 65_000, [prompt.openedAt, prompt.expiresAt]);
  await answer(w, id!, "once");
  check("an answer goes to the gateway", isDeepStrictEqual(w.sent, [{ id: `ap${ids}`, choice: "once" }]), w.sent);
  check("and waits for Hermes to apply it", stateOf(w, id!)?.kind === "sent", stateOf(w, id!));
  ended(w, "once");
  check("Hermes ending its wait with that answer confirms it", closedAs(stateOf(w, id!), "answered"), stateOf(w, id!));

  ask(w, { choices: ["once", "deny"], note: false });
  const [narrow] = asking(w);
  check("a smart-denied approval offers only Allow once and Deny, with no note where Hermes takes none",
    read(w, narrow!).content.options.map((o) => `${o.id}:${o.note ?? "-"}`).join() === "once:-,deny:-", read(w, narrow!).content.options);
  await answer(w, narrow!, "deny");
  ended(w, "deny");

  ask(w);
  const [noted] = asking(w);
  await answer(w, noted!, "deny", "Not the build folder.");
  check("a Deny carries the owner's note as Hermes's reason", isDeepStrictEqual(w.sent.at(-1), { id: `ap${ids}`, choice: "deny", reason: "Not the build folder." }), w.sent.at(-1));
  ended(w, "deny");
}

console.log("a session's answers go in the order its prompts opened");
{
  const w = world();
  const first = ask(w);
  const second = ask(w);
  const other = ask(w, { session: "agent:main:cotal:dm:u_peer.ada" });
  const [p1, p2, p3] = asking(w);
  await answer(w, p2!, "session");
  check("an answer to a later prompt waits for the earlier one", w.sent.length === 0, w.sent);
  await answer(w, p3!, "once");
  check("another session's answer does not wait", isDeepStrictEqual(w.sent.map((a) => a.id), [other]), w.sent);
  await answer(w, p1!, "once");
  check("answering the earlier one sends both, in order", isDeepStrictEqual(w.sent.map((a) => a.id), [other, first, second]), w.sent);
  ended(w, "once");
  ended(w, "session");
  check("each settles as Hermes ends its wait", closedAs(stateOf(w, p1!), "answered") && closedAs(stateOf(w, p2!), "answered"), [stateOf(w, p1!), stateOf(w, p2!)]);
}

console.log("Hermes stops waiting");
{
  const w = world();
  ask(w);
  const queued = ask(w);
  const [timedOut, next] = asking(w);
  await answer(w, next!, "once");
  ended(w, "timeout");
  check("Hermes's timeout withdraws the open prompt", closedAs(stateOf(w, timedOut!), "withdrawn"), stateOf(w, timedOut!));
  check("sends nothing for it, and lets the next answer go", isDeepStrictEqual(w.sent.map((a) => a.id), [queued]), w.sent);
  ended(w, "deny");
  const stopped = stateOf(w, next!);
  check("an answer Hermes did not apply, as on a stop, is unconfirmed with the refusal seen",
    stopped?.kind === "closed" && stopped.outcome.kind === "unconfirmed" && isDeepStrictEqual(stopped.outcome.seen, { tie: "prompt", effect: "refuse" }), stopped);
  ask(w);
  const [elsewhere] = asking(w);
  ended(w, "deny");
  check("an open prompt Hermes resolved at the gateway closes as answered there", closedAs(stateOf(w, elsewhere!), "local") && w.sent.length === 1, stateOf(w, elsewhere!));
  ended(w, "once");
  check("an end with no prompt waiting changes nothing", w.sent.length === 1 && list(w).open.length === 0);
}

console.log("one path: an approval no prompt can hold is denied");
{
  const unserved = world({ served: false });
  const id = ask(unserved);
  check("no served desk denies at once and names why",
    unserved.sent.length === 1 && unserved.sent[0]!.id === id && unserved.sent[0]!.choice === "deny" && /does not serve its prompt desk/.test(String(unserved.sent[0]!.reason)), unserved.sent);
  check("and logs it", unserved.warned.some((m) => /does not serve its prompt desk/.test(m)), unserved.warned);

  const full = world();
  for (let i = 0; i < 32; i++) ask(full, { session: `s${i}` });
  const over = ask(full, { session: "s-over" });
  check("a full desk denies at once and names why", full.sent.length === 1 && full.sent[0]!.id === over && full.sent[0]!.choice === "deny" && /could not ask/.test(String(full.sent[0]!.reason)), full.sent);

  const big = world();
  ask(big, { command: "x".repeat(300_000) });
  const bigPrompt = read(big, asking(big)[0]!);
  check("a command over the size limit shows by size and offers only Deny",
    isDeepStrictEqual((bigPrompt.content.subject as { input: unknown }).input, { kind: "omitted", bytes: 300_000 }) && bigPrompt.content.options.map((o) => o.id).join() === "deny");

  const bad = world();
  bad.approvals.request({ t: "approval", id: "x", session: "s", choices: ["once", "yolo", "deny"], timeoutMs: 1000 });
  bad.approvals.request({ t: "approval", id: "y", session: "s", choices: ["once"], timeoutMs: 1000 });
  check("a frame with choices Hermes does not have, or no Deny, opens nothing", list(bad).open.length === 0 && bad.sent.length === 0 && bad.warned.length === 2, bad.warned);

  const gone = world();
  ask(gone);
  gone.connected = false;
  const [goneId] = asking(gone);
  await answer(gone, goneId!, "once");
  check("an answer with no adapter to take it closes the prompt undelivered", closedAs(stateOf(gone, goneId!), "undelivered"), stateOf(gone, goneId!));
}

console.log("the launch field");
{
  check("hermes declares askPermissions and prompts", hermesConnector.supportsAskPermissions === true && hermesConnector.prompts === true);
  const launch = (askPermissions?: boolean) =>
    readLaunchMaterial(hermesConnector.buildLaunch({ space: "test", name: "hermes-ask", events: false, creds: "creds", model: "m", ...(askPermissions ? { askPermissions } : {}) }).env![LAUNCH_MATERIAL_ENV]!);
  check("an asking launch carries the field to the seat", launch(true).askPermissions === true);
  check("a launch without it carries nothing", launch().askPermissions === undefined);
  const adopt = process.env.COTAL_HERMES_ADOPT_HOME;
  process.env.COTAL_HERMES_ADOPT_HOME = "/srv/operator/.hermes";
  let refused = "";
  try {
    hermesConnector.buildLaunch({ space: "test", name: "hermes-adopt", events: false, creds: "creds", askPermissions: true });
  } catch (e) {
    refused = (e as Error).message;
  }
  if (adopt === undefined) delete process.env.COTAL_HERMES_ADOPT_HOME;
  else process.env.COTAL_HERMES_ADOPT_HOME = adopt;
  check("an adopted profile refuses askPermissions, as its approvals stay the operator's", /askPermissions needs a managed profile/.test(refused), refused);
  const home = mkdtempSync(join(tmpdir(), "cotal-hermes-ask-"));
  try {
    const mode = (askPermissions: boolean): string | undefined => {
      setupProfile(home, { model: "m", config: { space: "test", name: "hermes-ask", askPermissions } as AgentConfig });
      return /^approvals:\n {2}mode: (\w+)$/m.exec(readFileSync(join(home, "config.yaml"), "utf8"))?.[1];
    };
    check("a managed profile keeps approvals manual for an asking launch and off otherwise", mode(true) === "manual" && mode(false) === "off", [mode(true), mode(false)]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

finish();
