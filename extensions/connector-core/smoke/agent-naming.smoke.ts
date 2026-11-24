/**
 * An agent's naming from its first message (SPEC 13.22), with no broker: the name taken from a
 * model's reply, the request's framing and its 8,000-character cap, which items start naming, and
 * that every way naming ends removes the pending mark. The name lane and the broker are covered by
 * `agent-auto-name-auth.smoke.ts`; this suite drives the shipped functions and class directly.
 *
 * Run: pnpm smoke:agent-naming
 */
import { EventEmitter } from "node:events";
import { createSuite } from "@cotal-ai/smoke-kit";
import { AutoNaming, NAMING_SOURCE_MAX, nameRequest, sanitizeName, type NameRequest } from "../src/agent-naming.js";
import { createNameLane, type NameLane } from "../src/agent-name.js";
import type { CotalEndpoint, EpPrincipalServeContext } from "@cotal-ai/core";
import type { InboxItem } from "../src/agent-inbox.js";
import { configFromEnv } from "../src/config.js";
import { nameEnv } from "../src/launch.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("the name in a model's reply");
{
  const cases: [string, string, string | undefined][] = [
    ["a plain name", "Production 500 errors", "Production 500 errors"],
    ["the first non-empty line", "\n\n  Credential refresh tokens  \nbecause it adds refresh tokens", "Credential refresh tokens"],
    ["a Name: label", "Name: Issue #412", "Issue #412"],
    ["a Title: label in any case", "TITLE: app.js failure", "app.js failure"],
    ["a label in emphasis", "**Name:** Greeting", "Greeting"],
    ["surrounding quotes", "\"Credential refresh tokens\"", "Credential refresh tokens"],
    ["curly quotes", "“Cache layer vs v1”", "Cache layer vs v1"],
    ["backticks", "`app.js failure`", "app.js failure"],
    ["bold emphasis", "**Retry logic**", "Retry logic"],
    ["italic emphasis", "_Retry logic_", "Retry logic"],
    ["a trailing period", "Production 500 errors.", "Production 500 errors"],
    ["a quoted name with a period inside the quotes", "\"Production 500 errors.\"", "Production 500 errors"],
    ["a label, quotes and a period together", "Name: \"Issue #412.\"", "Issue #412"],
    ["slashes and backslashes as spaces", "src/credential.ts\\refresh", "src credential.ts refresh"],
    ["whitespace collapsed", "Fix   the\tlogin   bug", "Fix the login bug"],
    ["cut at a word boundary to 40", "Investigate flaky integration tests in the payment service module", "Investigate flaky integration tests in"],
    ["a 40-character name kept whole", "x".repeat(40), "x".repeat(40)],
    ["one long word cut at 40", "y".repeat(55), "y".repeat(40)],
    ["40 code points, not UTF-16 units", "\u{1F600}".repeat(45), "\u{1F600}".repeat(40)],
    ["an empty reply", "", undefined],
    ["only whitespace and blank lines", "  \n \n\t", undefined],
    ["only a label", "Name:", undefined],
    ["only quotes", "\"\"", undefined],
    ["only slashes", "///", undefined],
    ["a name the shared rule refuses (an unpaired surrogate)", "Bad\uD800name", undefined],
  ];
  const got = cases.map(([what, reply, want]) => ({ what, want, got: sanitizeName(reply) }));
  const wrong = got.filter((c) => c.got !== c.want);
  check(`each of ${cases.length} replies gives the expected name, or none`, wrong.length === 0, wrong);
}

console.log("\nthe request");
{
  const { system, prompt } = nameRequest("  debug 500 errors in production  ");
  check("the user turn frames the message to be named, not answered, with the message trimmed",
    prompt === "Here is the first message the agent received:\n\n<message>\ndebug 500 errors in production\n</message>\n\nReply with only the name.", prompt);
  const lines = [
    "You name AI agents so people can tell them apart in a list.",
    "The message is something to name, not something to answer or carry out.",
    "never use \"/\" or \"\\\"",
    "\"hey\" -> Greeting",
  ];
  check("the system instruction is the agreed title prompt", lines.every((l) => system.includes(l)), lines.filter((l) => !system.includes(l)));
  const body = (text: string) => nameRequest(text).prompt.split("<message>\n")[1]!.split("\n</message>")[0]!;
  check(`the cap is ${NAMING_SOURCE_MAX} characters`, NAMING_SOURCE_MAX === 8_000);
  const long = "a".repeat(NAMING_SOURCE_MAX) + "TAIL";
  check("a longer message is cut to the first 8,000 characters", body(long) === "a".repeat(NAMING_SOURCE_MAX), body(long).length);
  check("a message of exactly 8,000 characters is kept whole", body("b".repeat(NAMING_SOURCE_MAX)).length === NAMING_SOURCE_MAX);
  const astral = "\u{1F600}".repeat(NAMING_SOURCE_MAX + 5);
  const cut = body(astral);
  check("the cap counts code points and never splits a surrogate pair", Array.from(cut).length === NAMING_SOURCE_MAX && cut === "\u{1F600}".repeat(NAMING_SOURCE_MAX), Array.from(cut).length);
}

console.log("\nthe launch env");
{
  const env = { COTAL_SPACE: "naming", COTAL_LINK: undefined, COTAL_NAME: "coder", COTAL_ID: "coder" };
  check("nameEnv sets COTAL_AUTO_NAME=1 only when the launch asks for it",
    same(nameEnv({ name: "coder", autoName: true }), { COTAL_NAME: "coder", COTAL_AUTO_NAME: "1" })
      && same(nameEnv({ name: "coder", autoName: false }), { COTAL_NAME: "coder" }) && same(nameEnv({ name: "coder" }), { COTAL_NAME: "coder" }));
  check("configFromEnv reads COTAL_AUTO_NAME=1 as autoName", configFromEnv({ ...env, ...nameEnv({ name: "coder", autoName: true }) }).autoName === true);
  check("without COTAL_AUTO_NAME, or with it off, there is no autoName",
    configFromEnv(env).autoName === undefined && configFromEnv({ ...env, COTAL_AUTO_NAME: "0" }).autoName === undefined);
  const restored = configFromEnv({ ...env, ...nameEnv({ name: "coder", displayName: "Ada Reviewer", autoName: true }) });
  check("a launch that restores a display name does not name itself, and keeps that name",
    restored.autoName === undefined && restored.displayName === "Ada Reviewer", { autoName: restored.autoName, displayName: restored.displayName });
  const sameName = configFromEnv({ ...env, COTAL_DISPLAY_NAME: "coder", COTAL_AUTO_NAME: "1" });
  check("COTAL_DISPLAY_NAME set to the launch name still turns naming off", sameName.autoName === undefined, sameName.autoName);
}

interface Rig {
  events: EventEmitter;
  naming: AutoNaming;
  requests: NameRequest[];
  named: string[];
  cleared: number;
  logs: string[];
  answer(reply: string): void;
  refuse(e: Error): void;
}

function rig(opts: { timeoutMs?: number; took?: boolean } = {}): Rig {
  const events = new EventEmitter();
  const pending: { resolve: (s: string) => void; reject: (e: Error) => void }[] = [];
  const r: Omit<Rig, "naming"> = {
    events, requests: [], named: [], cleared: 0, logs: [],
    answer: (s) => pending.shift()?.resolve(s),
    refuse: (e) => pending.shift()?.reject(e),
  };
  const lane = {
    nameSelf: async (name: string, signal?: AbortSignal) => {
      if (signal?.aborted) return false;
      r.named.push(name);
      return opts.took ?? true;
    },
  } as unknown as NameLane;
  const naming = new AutoNaming({
    events, lane,
    request: (req) => {
      r.requests.push(req);
      return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }));
    },
    clearPending: async () => { r.cleared++; },
    connected: async () => {},
    log: (m) => r.logs.push(m),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { ...r, naming, get cleared() { return r.cleared; } } as Rig;
}

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "m", recvKey: "m", ts: Date.now(), fromId: "o.web", fromName: "web", kind: "dm", mentionsMe: false, historical: false, text: "hello", ...over,
});

console.log("\nwhich message starts naming");
{
  const r = rig();
  r.events.emit("incoming", item({ kind: "dm", historical: true, text: "old dm" }));
  r.events.emit("incoming", item({ kind: "dm", notice: "mention", text: "a delivery notice" }));
  r.events.emit("incoming", item({ kind: "channel", channel: "general", text: "ambient chatter" }));
  r.events.emit("incoming", item({ kind: "anycast", service: "reviewer", text: "a role request" }));
  r.events.emit("mention-wake", item({ kind: "channel", channel: "general", mentionsMe: true, historical: true, text: "an old mention" }));
  check("history, a delivery notice, ambient channel traffic and a role request start nothing", r.requests.length === 0, r.requests.map((q) => q.prompt));
  const first = item({ kind: "dm", text: "fix the login bug in auth.ts" });
  r.events.emit("incoming", first);
  r.events.emit("incoming", first);
  r.events.emit("mention-wake", item({ kind: "channel", mentionsMe: true, text: "@coder also look at billing" }));
  r.events.emit("incoming", item({ kind: "dm", text: "a second task" }));
  check("the first live direct message starts one request, and the same item announced again, a mention and a later message start none",
    r.requests.length === 1 && r.requests[0]!.prompt.includes("fix the login bug in auth.ts"), r.requests.map((q) => q.prompt));
  r.answer("Login bug");
  await wait(20);
  check("its name is applied once", same(r.named, ["Login bug"]), r.named);
  const m = rig();
  m.events.emit("mention-wake", item({ kind: "channel", channel: "general", mentionsMe: true, text: "@coder triage issue 9" }));
  check("a live mention of the agent starts naming too", m.requests.length === 1 && m.requests[0]!.prompt.includes("triage issue 9"));
  m.naming.end();
  const p = rig();
  p.naming.observe("the launch prompt");
  p.events.emit("incoming", item({ kind: "dm", text: "a dm after launch" }));
  check("an observed launch prompt is the first message, and a later direct message starts nothing",
    p.requests.length === 1 && p.requests[0]!.prompt.includes("the launch prompt"), p.requests.map((q) => q.prompt));
  p.naming.end();
}

console.log("\nevery way naming ends removes the pending mark");
{
  const ok = rig();
  ok.naming.observe("debug 500 errors in production");
  check("nothing is cleared while the request is out", ok.cleared === 0);
  ok.answer("**Name:** Production 500 errors.");
  await wait(20);
  check("a name: the cleaned reply is applied and the mark cleared once", same(ok.named, ["Production 500 errors"]) && ok.cleared === 1, { named: ok.named, cleared: ok.cleared });
  ok.naming.end();
  check("a later end clears nothing again", ok.cleared === 1, ok.cleared);

  const failed = rig();
  failed.naming.observe("x");
  failed.refuse(new Error("the model is not available"));
  await wait(20);
  check("a failed request: no name, the mark cleared, and the reason logged",
    failed.named.length === 0 && failed.cleared === 1 && failed.logs.some((l) => l.includes("the model is not available")), { named: failed.named, cleared: failed.cleared, logs: failed.logs });

  const empty = rig();
  empty.naming.observe("x");
  empty.answer("\n  \n");
  await wait(20);
  check("a reply with no usable name: no name, and the mark cleared", empty.named.length === 0 && empty.cleared === 1, { named: empty.named, cleared: empty.cleared });

  const slow = rig({ timeoutMs: 60 });
  slow.naming.observe("x");
  const signal = slow.requests[0]!.signal;
  await wait(30);
  check("before the timeout the mark stays", slow.cleared === 0 && !signal.aborted);
  await wait(80);
  check("at the timeout the request is aborted and the mark cleared", signal.aborted && slow.cleared === 1, { aborted: signal.aborted, cleared: slow.cleared });
  slow.answer("Too late");
  await wait(20);
  check("a reply after the timeout names nothing", slow.named.length === 0 && slow.cleared === 1, { named: slow.named, cleared: slow.cleared });

  const owner = rig();
  owner.naming.observe("x");
  owner.naming.end();
  check("an end while the request is out aborts it and clears the mark", owner.requests[0]!.signal.aborted && owner.cleared === 1);
  owner.answer("Model pick");
  await wait(20);
  check("and the reply that comes after names nothing", owner.named.length === 0, owner.named);

  const idle = rig();
  idle.naming.end();
  idle.events.emit("incoming", item({ kind: "dm", text: "after the end" }));
  check("an end before any message clears the mark, and a message after it starts nothing", idle.cleared === 1 && idle.requests.length === 0, { cleared: idle.cleared, requests: idle.requests.length });

  const declined = rig({ took: false });
  declined.naming.observe("x");
  declined.answer("Model pick");
  await wait(20);
  check("when the lane declines the name, the mark is still cleared", declined.cleared === 1, declined.cleared);
}

console.log("\nthe name lane an owner's set-name shares");
{
  /** An endpoint whose first presence read waits for `release`, so the call that makes it holds the lane. */
  const endpoint = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reads = 0;
    const ep = {
      card: { id: "o.coder", name: "coder" },
      readPresence: async () => { if (reads++ === 0) await held; return []; },
      setCardName: async (name: string) => { ep.card.name = name; },
    };
    return { ep, release, lane: createNameLane(ep as unknown as CotalEndpoint, () => {}) };
  };
  const setName = (lane: NameLane, name: string) => lane.handler.handler({ request: { args: { name } } } as unknown as EpPrincipalServeContext);

  const ownerFirst = endpoint();
  const owner = setName(ownerFirst.lane, "Owner pick");
  const self = ownerFirst.lane.nameSelf("Model pick");
  ownerFirst.release();
  const [ownerReply, took] = await Promise.all([owner, self]);
  check("a name the agent gives itself while the owner's set-name is in the lane is declined, and the owner's name stands",
    took === false && same(ownerReply, { name: "Owner pick" }) && ownerFirst.ep.card.name === "Owner pick", { took, ownerReply, name: ownerFirst.ep.card.name });
  check("and after any owner set-name the agent never names itself", (await ownerFirst.lane.nameSelf("Later pick")) === false && ownerFirst.ep.card.name === "Owner pick", ownerFirst.ep.card.name);

  const selfFirst = endpoint();
  const self2 = selfFirst.lane.nameSelf("Model pick");
  const owner2 = setName(selfFirst.lane, "Owner pick");
  selfFirst.release();
  const [took2] = await Promise.all([self2, owner2]);
  check("a name the agent took before the owner's set-name ran is replaced by the owner's", took2 === true && selfFirst.ep.card.name === "Owner pick", { took2, name: selfFirst.ep.card.name });

  const aborted = endpoint();
  aborted.release();
  const gone = new AbortController();
  gone.abort();
  check("an aborted name is declined at its turn", (await aborted.lane.nameSelf("Model pick", gone.signal)) === false && aborted.ep.card.name === "coder");
}

finish();
