/**
 * The inert service-relay engine against an owned, in-process fake of the SD2-P r4 service rules.
 *
 * NOT A NATIVE, HOST OR LIVE PROOF. The fake implements r4 §2 (one offered head, the data and control
 * cursors, re-offer, service-side withdrawal, control acknowledgement) per caller, keyed by the
 * identity a broker subject would fix. It also stands in for the three ports that do not exist yet:
 * the native self-mode request, the authorized endpoint inventory and the host frame verdict, and the
 * liveness cells model the cadence and the host's wake and level checks. Every count below is this
 * engine's behavior against that fake. The suite is not registered in the CI suite list, and nothing
 * in production imports the module.
 *
 * Run: pnpm exec tsx extensions/connector-core/smoke/service-relay.smoke.ts
 */
import { RELAY_HOOK_READ_MS, ServiceRelay, type RelayCall, type RelayPin, type ServiceRelayHost } from "../src/service-relay.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra === undefined ? "" : JSON.stringify(extra));
  }
};
const threw = async (n: string, fn: () => Promise<unknown>, wants: RegExp) => {
  try {
    await fn();
    c(n, false, "did not throw");
  } catch (e) {
    c(n, wants.test((e as Error).message), (e as Error).message);
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const json = (v: unknown) => JSON.stringify(v);
const REPEAT = "may be a repeat";

const PIN: RelayPin = {
  space: "s1", owner: "o1", actor: "a1", lifecycleUid: "u1", grantId: "g1", approvalDigest: "sha256:approval",
  endpoint: "svc.example", contract: "sha256:contract-1", poll: "relay.poll", read: "relay.read",
};
const UID1 = "s1/o1/a1/u1";

interface Item { id: string; kind: "notice" | "deferred"; text?: string; body?: string; live: boolean; released: boolean; resolved?: { outcome: string; by: "client" | "service"; reason?: string } }
interface Ctl { id: string; class: "priority" | "notice"; text: string }
interface Caller { data: Item[]; control: Ctl[]; ack: number; returned: number; lastClient?: { item: string; outcome: string } }
interface Sent { uid: string; command: string; args: Record<string, unknown>; deadlineMs: number }
const everySent: Sent[] = [];

const refuse = (code: string, message: string, reason?: "contract" | "cursor" | "live", current?: string): RelayCall =>
  ({ ok: false, code, message, ...(reason !== undefined ? { reason } : {}), ...(current !== undefined ? { current } : {}) });

/** r4 §2 for each caller, applied atomically per request. */
class FakeService {
  contract = "sha256:contract-1";
  readonly callers = new Map<string, Caller>();
  readonly requests: Sent[] = [];
  /** Apply the next request of that kind, then lose its reply. */
  lose = { poll: 0, read: 0 };
  readDelayMs = 0;
  /** The next poll is refused with this, before anything is applied. */
  refuseNext: RelayCall | undefined;
  /** The next poll's reply waits for this after the request is applied. */
  hold: Promise<void> | undefined;

  caller(uid: string): Caller {
    let st = this.callers.get(uid);
    if (st === undefined) this.callers.set(uid, (st = { data: [], control: [], ack: -1, returned: -1 }));
    return st;
  }

  private head(st: Caller): Item | undefined {
    return st.data.find((i) => i.resolved === undefined);
  }

  readonly invoke = async (call: Parameters<ServiceRelayHost["invoke"]>[0]): Promise<RelayCall> => {
    // The broker fixes the caller in the subject; the body is never consulted for identity.
    const uid = `${call.pin.space}/${call.pin.owner}/${call.pin.actor}/${call.pin.lifecycleUid}`;
    const sent = { uid, command: call.command, args: call.args, deadlineMs: call.deadlineMs };
    this.requests.push(sent);
    everySent.push(sent);
    const st = this.caller(uid);
    if (call.command === call.pin.poll) return this.poll(st, call.args);
    if (call.command === call.pin.read) return this.read(st, call.args);
    return refuse("not-found", `no command ${call.command}`);
  };

  private async poll(st: Caller, body: Record<string, unknown>): Promise<RelayCall> {
    if (this.refuseNext !== undefined) {
      const r = this.refuseNext;
      this.refuseNext = undefined;
      return r;
    }
    if (Object.keys(body).some((k) => !["contract", "control", "data", "held"].includes(k))) return refuse("bad-request", "unknown request field");
    if ("data" in body && "held" in body) return refuse("bad-request", "data and held together");
    if (body.contract !== this.contract) return refuse("failed-precondition", "stale contract", "contract", this.contract);
    const after = (body.control as { after: string | null }).after;
    let ack = st.ack;
    if (after !== null) {
      const i = st.control.findIndex((x) => x.id === after);
      if (i < 0 || i < st.ack || i > st.returned) return refuse("failed-precondition", "control cursor", "cursor");
      ack = i;
    }
    const head = this.head(st);
    let apply: (() => void) | undefined;
    let held: Record<string, unknown> | undefined;
    if ("held" in body) {
      if (head === undefined || body.held !== head.id) return refuse("failed-precondition", "held is not the head", "cursor");
      held = { id: head.id, state: head.live ? "live" : "withdrawn", ...(head.live ? {} : { reason: "authority ended" }) };
    } else {
      const data = body.data as { after?: string | null; resolved?: { item: string; outcome: string; reason?: string } };
      const r = data.resolved;
      if (r !== undefined) {
        if (head !== undefined && r.item === head.id) {
          if (r.outcome === "skipped" && head.live) return refuse("failed-precondition", "the head is live", "live");
          apply = () => {
            head.resolved = { outcome: r.outcome, by: "client", ...(r.reason !== undefined ? { reason: r.reason } : {}) };
            st.lastClient = { item: r.item, outcome: r.outcome };
          };
        } else if (st.lastClient !== undefined && r.item === st.lastClient.item) {
          if (r.outcome !== st.lastClient.outcome) return refuse("conflict", "already resolved otherwise");
        } else return refuse("failed-precondition", "not the head", "cursor");
      } else if (data.after !== null && data.after !== undefined) {
        const i = st.data.findIndex((x) => x.id === data.after);
        const lo = st.lastClient === undefined ? -1 : st.data.findIndex((x) => x.id === st.lastClient!.item);
        let hi = -1;
        st.data.forEach((x, n) => { if (x.resolved !== undefined) hi = n; });
        if (i < 0 || i < lo || i > hi) return refuse("failed-precondition", "data cursor", "cursor");
      }
    }
    st.ack = ack;
    apply?.();
    const control = st.control.slice(st.ack + 1, st.ack + 1 + 16);
    st.returned = Math.max(st.returned, st.ack + control.length);
    const reply: Record<string, unknown> = { control };
    if (held !== undefined) reply.held = held;
    else {
      // Authority is re-checked at every offer; a head whose authority ended is resolved here.
      let h = this.head(st);
      while (h !== undefined && !h.live) {
        h.resolved = { outcome: "skipped", by: "service", reason: "authority ended" };
        h = this.head(st);
      }
      if (h !== undefined) reply.data = { id: h.id, kind: h.kind, ...(h.kind === "notice" ? { text: h.text } : {}), repeat: h.released };
    }
    if (this.hold !== undefined) {
      const wait = this.hold;
      this.hold = undefined;
      await wait;
    }
    if (this.lose.poll > 0) {
      this.lose.poll -= 1;
      return refuse("deadline-exceeded", "reply lost");
    }
    return { ok: true, data: reply };
  }

  private async read(st: Caller, body: Record<string, unknown>): Promise<RelayCall> {
    if (Object.keys(body).join() !== "item") return refuse("bad-request", "read takes item only");
    const head = this.head(st);
    if (head === undefined || body.item !== head.id) return refuse("failed-precondition", "read is not of the head", "cursor");
    let reply: Record<string, unknown>;
    if (!head.live) {
      head.resolved = { outcome: "skipped", by: "service", reason: "authority ended" };
      reply = { withdrawn: "authority ended" };
    } else if (bytes({ text: head.body }) > 65_536) {
      head.resolved = { outcome: "skipped", by: "service", reason: "too-large" };
      reply = { withdrawn: "too-large" };
    } else {
      head.released = true;
      reply = { text: head.body };
    }
    if (this.readDelayMs > 0) await sleep(this.readDelayMs);
    if (this.lose.read > 0) {
      this.lose.read -= 1;
      return refuse("deadline-exceeded", "reply lost");
    }
    return { ok: true, data: reply };
  }
}

type TestHost = ServiceRelayHost & { wakes: number; logs: string[]; refreshes: string[]; frames: string[] };
const mkHost = (invoke: ServiceRelayHost["invoke"]): TestHost => {
  const h: TestHost = {
    wakes: 0, logs: [], refreshes: [], frames: [],
    invoke,
    wake: () => { h.wakes += 1; },
    refresh: (reason) => { h.refreshes.push(reason); },
    log: (line) => { h.logs.push(line); },
  };
  return h;
};
const fresh = () => {
  const svc = new FakeService();
  const h = mkHost(svc.invoke);
  const relay = new ServiceRelay(h);
  relay.setPin(PIN);
  return { svc, h, relay, u: svc.caller(UID1) };
};
/** Every frame text a test surfaced, for the stop-claim census. */
const surfaced: string[] = [];
const look = (relay: ServiceRelay) => {
  const p = relay.peek();
  if (p !== undefined) surfaced.push(p.text);
  return p;
};
const lastArgs = (svc: FakeService) => svc.requests.at(-1)!.args;

// ── the pin boundary ──────────────────────────────────────────────────────────────────────────
{
  const svc = new FakeService();
  const h = mkHost(svc.invoke);
  const relay = new ServiceRelay(h);
  relay.setPin({ ...PIN, owner: "" });
  await relay.poll(1000);
  c("pin:an empty identity field refuses loudly and sends nothing", h.logs.includes("relay inactive: pin field owner is empty") && svc.requests.length === 0 && !relay.status().active, h.logs);
  relay.setPin({ inactive: "host has no relay verdict" });
  await relay.poll(1000);
  c("pin:a host with no relay verdict stays inactive and says why", h.logs.includes("relay inactive: host has no relay verdict") && relay.status().inactive === "host has no relay verdict" && svc.requests.length === 0, relay.status());
  relay.setPin(undefined);
  c("pin:a missing pin deactivates with its reason", h.logs.includes("relay inactive: no relay pin") && !relay.status().active);
  await threw("pin:a non-finite poll deadline is refused", () => relay.poll(Number.NaN), /finite positive deadline/);
  await threw("pin:a non-finite read deadline is refused", () => relay.prepare(Number.POSITIVE_INFINITY, "wake"), /finite positive deadline/);
}

// ── empty polls wake nothing ──────────────────────────────────────────────────────────────────
{
  const { svc, h, relay } = fresh();
  for (let i = 0; i < 5; i++) await relay.poll(1000);
  const k = relay.counts();
  c("empty:five empty polls send five requests and wake nothing", svc.requests.length === 5 && k.polls === 5 && k.emptyPolls === 5 && k.wakes === 0 && h.wakes === 0 && look(relay) === undefined, k);
}

// ── a notice, delivered exactly once across a lost reply ──────────────────────────────────────
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "d1", kind: "notice", text: "line one\nline two", live: true, released: false });
  await relay.poll(1000);
  const p = look(relay);
  c("notice:an offered notice wakes once and rides the next frame with every line indented", h.wakes === 1 && p?.text.includes("[item d1] line one\n  line two") === true, p?.text);
  relay.commit(p!.frame, true);
  svc.lose.poll = 1;
  await relay.poll(1000);
  await relay.poll(1000);
  const sent = svc.requests.slice(-2).map((r) => json(r.args.data));
  c("notice:a resolution retried after a lost reply is the identical request", sent[0] === sent[1] && sent[0] === json({ resolved: { item: "d1", outcome: "delivered" } }), sent);
  c("notice:the service records exactly one delivered, from the client", u.data[0]!.resolved?.outcome === "delivered" && u.data[0]!.resolved.by === "client" && relay.counts().retries === 1, u.data[0]);
  await relay.poll(1000);
  c("notice:after its resolution the data cursor resumes after it, and the empty poll wakes nothing", json(lastArgs(svc).data) === json({ after: "d1" }) && h.wakes === 1, lastArgs(svc));
}

// ── a deferred item read on the hook path ─────────────────────────────────────────────────────
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "d2", kind: "deferred", body: "deferred body", live: true, released: false });
  await relay.poll(1000);
  c("deferred:an offered deferred item wakes nothing before its read, and is not an empty poll", h.wakes === 0 && relay.counts().emptyPolls === 0 && look(relay) === undefined, relay.counts());
  await relay.prepare(10_000, "hook");
  const read = svc.requests.at(-1)!;
  c("deferred:a hook-path read is clamped to the hook budget", read.command === "relay.read" && read.deadlineMs === RELAY_HOOK_READ_MS && json(read.args) === json({ item: "d2" }), read);
  const p = look(relay)!;
  c("deferred:the read text rides the next frame", p.text.includes("[item d2] deferred body"), p.text);
  await relay.poll(1000);
  c("deferred:while its frame awaits a verdict the poll carries held", lastArgs(svc).held === "d2" && !("data" in lastArgs(svc)), lastArgs(svc));
  relay.commit(p.frame, true);
  await relay.poll(1000);
  c("deferred:the verdict delivers it once", u.data[0]!.resolved?.outcome === "delivered" && u.data[0]!.resolved.by === "client", u.data[0]);
  await relay.prepare(500, "hook");
  c("deferred:a read with nothing held sends nothing", svc.requests.filter((r) => r.command === "relay.read").length === 1);
}

// ── a read that times out is read again, never skipped ────────────────────────────────────────
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "d3", kind: "deferred", body: "slow body", live: true, released: false });
  await relay.poll(1000);
  svc.readDelayMs = 80;
  await relay.prepare(20, "wake");
  c("timeout:a read past its deadline counts, and leaves the item held, unread and unresolved", relay.counts().readTimeouts === 1 && relay.status().held === "d3" && look(relay) === undefined && u.data[0]!.resolved === undefined, relay.counts());
  await sleep(120);
  c("timeout:the late reply is discarded", look(relay) === undefined && relay.status().held === "d3");
  svc.readDelayMs = 0;
  await relay.prepare(1000, "wake");
  const p = look(relay);
  c("timeout:the next prepare reads again and the item surfaces", svc.requests.filter((r) => r.command === "relay.read").length === 2 && p?.text.includes("[item d3] slow body") === true, p?.text);
}

// ── an undelivered verdict: read again, surfaced with the repeat label ───────────────────────
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "d4", kind: "deferred", body: "maybe twice", live: true, released: false });
  await relay.poll(1000);
  await relay.prepare(1000, "wake");
  const first = look(relay)!;
  relay.commit(first.frame, false);
  c("undelivered:an undelivered deferred item is not surfaced again before it is read again", look(relay) === undefined);
  await relay.prepare(1000, "wake");
  const again = look(relay)!;
  c("undelivered:it is read again and surfaced with the repeat label", svc.requests.filter((r) => r.command === "relay.read").length === 2 && again.text.includes(REPEAT) && relay.counts().repeatFrames === 1, again.text);
  relay.commit(again.frame, true);
  await relay.poll(1000);
  c("undelivered:it is delivered only on the later verdict, once", u.data[0]!.resolved?.outcome === "delivered", u.data[0]);
  relay.commit(first.frame, true);
  c("undelivered:a second verdict for an already-judged frame changes nothing", relay.counts().staleCommits === 1);
}

// ── control is independent of the held item ──────────────────────────────────────────────────
{
  const { svc, h, relay, u } = fresh();
  u.data.push(
    { id: "d5", kind: "deferred", body: "body five", live: true, released: false },
    { id: "d6", kind: "notice", text: "under another binding", live: true, released: false },
  );
  await relay.poll(1000);
  u.control.push({ id: "c1", class: "priority", text: "priority while fetched" });
  await relay.poll(1000);
  const p1 = look(relay)!;
  c("control:a priority item is learned while a data item is held, and wakes", relay.counts().controlWhileHeld === 1 && h.wakes === 1 && p1.text.includes("[priority c1]") && !p1.text.includes("[item d5]"), p1.text);
  relay.commit(p1.frame, true);
  await relay.prepare(1000, "wake");
  const p2 = look(relay)!;
  c("control:the held item surfaces once read, and a delivered control item does not return", p2.text.includes("[item d5] body five") && !p2.text.includes("[priority c1]"), p2.text);
  u.control.push({ id: "c2", class: "priority", text: "binding ended" });
  u.data[0]!.live = false;
  await relay.poll(1000);
  c("control:the poll acknowledged the delivered prefix", (lastArgs(svc).control as { after: unknown }).after === "c1" && u.ack === 0, lastArgs(svc));
  const p3 = look(relay)!;
  c("control:an item whose own authority ended is dropped before surfacing, and the priority rides alone", p3.text.includes("[priority c2]") && !p3.text.includes("[item d5]") && relay.status().unreported === "d5", p3.text);
  relay.commit(p2.frame, true);
  c("control:a late verdict for the withdrawn item delivers nothing", relay.status().unreported === "d5" && relay.status().held === undefined);
  relay.commit(p3.frame, true);
  await relay.poll(1000);
  c("control:skipped is reported only for the withdrawn item, and the service accepts it", json(lastArgs(svc).data) === json({ resolved: { item: "d5", outcome: "skipped", reason: "authority ended" } }) && u.data[0]!.resolved?.by === "client" && u.data[0]!.resolved.outcome === "skipped", u.data[0]);
  const p4 = look(relay)!;
  relay.commit(p4.frame, true);
  await relay.poll(1000);
  c("control:an item under another binding stays live and is delivered", u.data[1]!.resolved?.outcome === "delivered", u.data[1]);
}

// ── a skipped the service refuses as live is never treated as accepted ───────────────────────
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "d7", kind: "deferred", body: "back again", live: true, released: false });
  await relay.poll(1000);
  u.data[0]!.live = false;
  await relay.poll(1000);
  u.data[0]!.live = true;
  await relay.poll(1000);
  c("live:a client skipped for a live head is refused live, and the relay resyncs", relay.counts().resyncs === 1 && u.data[0]!.resolved === undefined && relay.status().unreported === undefined, relay.status());
  await relay.poll(1000);
  c("live:the resync resumes from after:null and the head comes back", json(lastArgs(svc).data) === json({ after: null }) && relay.status().held === "d7", lastArgs(svc));
}

// ── C1: the service's own withdrawal wins the race against the client's skipped ──────────────
{
  const { svc, relay, u } = fresh();
  u.data.push(
    { id: "d8", kind: "deferred", body: "never shown", live: true, released: false },
    { id: "d9", kind: "notice", text: "next", live: true, released: false },
  );
  await relay.poll(1000);
  u.data[0]!.live = false;
  await relay.prepare(1000, "wake");
  c("race:a read of a withdrawn item returns withdrawn, and the service resolves it itself", u.data[0]!.resolved?.by === "service" && relay.status().unreported === "d8" && look(relay) === undefined, u.data[0]);
  await relay.poll(1000);
  c("race:the client's skipped is refused cursor and is not treated as accepted", relay.counts().resyncs === 1 && u.data[0]!.resolved?.by === "service" && relay.status().unreported === undefined && relay.status().held === undefined);
  await relay.poll(1000);
  const a = lastArgs(svc);
  c("race:the resync resumes both cursors from the service's position", json(a.data) === json({ after: null }) && json(a.control) === json({ after: null }) && relay.status().held === "d9", a);
}

// ── control acknowledgement is the contiguous delivered prefix, never the highest id ─────────
{
  const { svc, relay, u } = fresh();
  u.control.push({ id: "zz9", class: "notice", text: "earlier notice" });
  await relay.poll(1000);
  const f1 = look(relay)!;
  u.control.push({ id: "aa1", class: "priority", text: "later priority" });
  await relay.poll(1000);
  const f2 = look(relay)!;
  c("ack:priority surfaces ahead of the earlier notice", f2.text.indexOf("[priority aa1]") >= 0 && f2.text.indexOf("[priority aa1]") < f2.text.indexOf("[notice zz9]"), f2.text);
  relay.commit(f2.frame, false);
  relay.commit(f1.frame, true);
  await relay.poll(1000);
  c("ack:only the contiguous delivered prefix is acknowledged", (lastArgs(svc).control as { after: unknown }).after === "zz9" && u.ack === 0, lastArgs(svc));
  const f3 = look(relay)!;
  c("ack:the undelivered priority surfaces again with the repeat label", f3.text.includes("[priority aa1]") && !f3.text.includes("zz9") && f3.text.includes(REPEAT), f3.text);
  await relay.poll(1000);
  c("ack:it is not acknowledged before its own verdict", (lastArgs(svc).control as { after: unknown }).after === null && u.ack === 0, lastArgs(svc));
  relay.commit(f3.frame, true);
  await relay.poll(1000);
  c("ack:its own verdict acknowledges it", (lastArgs(svc).control as { after: unknown }).after === "aa1" && u.ack === 1, lastArgs(svc));
}

// ── transient failures, conflict, and the refresh triggers ────────────────────────────────────
{
  const { svc, relay } = fresh();
  svc.refuseNext = { ok: false, code: "unavailable", message: "no responders" };
  await relay.poll(1000);
  await relay.poll(1000);
  const [a, b] = svc.requests.slice(-2);
  c("retry:a transient failure sends the identical request again", json(a!.args) === json(b!.args) && relay.counts().retries === 1, relay.counts());
  svc.refuseNext = { ok: false, code: "conflict", message: "resolved otherwise" };
  await relay.poll(1000);
  await relay.poll(1000);
  c("retry:a conflict resyncs from the service's position", relay.counts().resyncs === 1 && json(lastArgs(svc).control) === json({ after: null }), lastArgs(svc));
}
{
  const { svc, h, relay } = fresh();
  svc.contract = "sha256:contract-2";
  await relay.poll(1000);
  c("refresh:a contract refusal asks for discovery and holds the relay", h.refreshes.join() === "contract" && relay.status().refreshing && relay.counts().refreshes === 1, relay.status());
  const n = svc.requests.length;
  await relay.poll(1000);
  c("refresh:nothing is sent while discovery is pending", svc.requests.length === n);
  relay.setPin({ ...PIN, contract: "sha256:contract-2" });
  await relay.poll(1000);
  c("refresh:a new pin carrying the current contract polls again", relay.status().active && svc.requests.length === n + 1 && lastArgs(svc).contract === "sha256:contract-2", relay.status());
  svc.refuseNext = { ok: false, code: "permission-denied", message: "no reach" };
  await relay.poll(1000);
  c("refresh:a permission refusal asks for discovery", h.refreshes.join() === "contract,permission" && relay.status().refreshing);
  relay.setPin({ ...PIN, contract: "sha256:contract-2" });
  c("refresh:the identical re-verified pin resumes without a reset", !relay.status().refreshing && relay.status().active);
}

// ── transport loss, an identical pin, a restart and a new lifecycle UID ──────────────────────
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "e1", kind: "deferred", body: "kept", live: true, released: false });
  u.control.push({ id: "k1", class: "notice", text: "kept notice" });
  await relay.poll(1000);
  await relay.prepare(1000, "wake");
  const f = look(relay)!;
  relay.commit(f.frame, true);
  const gen = relay.status().generation;
  relay.pause();
  const before = svc.requests.length;
  await relay.poll(1000);
  c("pause:a paused relay sends nothing and surfaces nothing", svc.requests.length === before && look(relay) === undefined);
  relay.setPin({ ...PIN });
  c("pause:an identical re-verified pin keeps the unreported outcome", relay.status().unreported === "e1" && relay.status().generation === gen, relay.status());
  relay.resume();
  await relay.poll(1000);
  c("pause:after resume the outcome is reported once and the control prefix acknowledged", u.data[0]!.resolved?.outcome === "delivered" && u.ack === 0, { item: u.data[0], ack: u.ack });
}
{
  const svc = new FakeService();
  const u = svc.caller(UID1);
  u.data.push({ id: "r1", kind: "deferred", body: "released before", live: true, released: false });
  u.control.push({ id: "q1", class: "notice", text: "unacknowledged" });
  const first = new ServiceRelay(mkHost(svc.invoke));
  first.setPin(PIN);
  await first.poll(1000);
  await first.prepare(1000, "wake");
  const second = new ServiceRelay(mkHost(svc.invoke));
  second.setPin(PIN);
  await second.poll(1000);
  const a = lastArgs(svc);
  c("restart:a restarted connector sends after:null for both cursors", json(a.control) === json({ after: null }) && json(a.data) === json({ after: null }), a);
  await second.prepare(1000, "wake");
  const p = look(second);
  c("restart:the same UID gets its head again with the service's repeat flag, and every unacknowledged control item", p?.text.includes(REPEAT) === true && p.text.includes("[item r1] released before") && p.text.includes("[notice q1]"), p?.text);
}
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "n1", kind: "notice", text: "old uid item", live: true, released: false });
  await relay.poll(1000);
  const old = look(relay)!;
  const gen = relay.status().generation;
  relay.setPin({ ...PIN, lifecycleUid: "u2" });
  relay.commit(old.frame, true);
  c("newuid:a new lifecycle UID replaces the generation and drops the held item without a report", relay.status().generation === gen + 1 && relay.status().held === undefined && relay.counts().staleCommits === 1, relay.status());
  await relay.poll(1000);
  const last = svc.requests.at(-1)!;
  c("newuid:the old UID's item stays unresolved, and the new UID starts from after:null", u.data[0]!.resolved === undefined && last.uid.endsWith("/u2") && json(last.args.data) === json({ after: null }), last);
}
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "s1", kind: "notice", text: "late", live: true, released: false });
  let release!: () => void;
  svc.hold = new Promise<void>((r) => { release = r; });
  const pending = relay.poll(1000);
  await sleep(0);
  relay.setPin({ ...PIN, grantId: "g2" });
  release();
  await pending;
  c("stale:a reply that returns after the pin changed is discarded unread", relay.counts().staleReplies === 1 && h.wakes === 0 && relay.status().held === undefined, relay.counts());
}

// ── liveness, driven by the cadence and the host's own wakes ──────────────────────────────────
/**
 * The integration this follow-up assumes, modeled here and wired nowhere. Each cadence tick polls once
 * and, while pending() says a read is needed, reads on the wake path. Each host wake asks for one
 * frame, which the host builds only while pending() has something surfaceable: it reads on the hook
 * path, surfaces with peek() and judges the frame with the next scripted verdict. At the end of each
 * frame the host checks the same level once more, as it does for its own inbox. No test forces a frame.
 */
class Driven {
  readonly svc = new FakeService();
  readonly h = mkHost(this.svc.invoke);
  readonly relay = new ServiceRelay(this.h);
  readonly u = this.svc.caller(UID1);
  readonly frames: string[] = [];
  readonly verdicts: boolean[] = [];
  readMs = 1000;
  hookMs = RELAY_HOOK_READ_MS;
  private asked = 0;

  constructor() {
    const counted = this.h.wake;
    this.h.wake = () => {
      counted();
      this.asked += 1;
    };
    this.relay.setPin(PIN);
  }

  async tick(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.relay.poll(1000);
      if (this.relay.pending().needsRead) await this.relay.prepare(this.readMs, "wake");
      await this.serve();
    }
  }

  async serve(): Promise<void> {
    while (this.asked > 0 && this.frames.length < 20) {
      this.asked -= 1;
      if (this.relay.pending().surfaceable === 0) continue;
      await this.relay.prepare(this.hookMs, "hook");
      const p = look(this.relay);
      if (p === undefined) continue;
      this.frames.push(p.text);
      this.relay.commit(p.frame, this.verdicts.shift() ?? true);
      if (this.relay.pending().surfaceable > 0) this.asked += 1;
    }
  }
}
const reads = (svc: FakeService) => svc.requests.filter((r) => r.command === "relay.read").length;
const NONE = json({ surfaceable: 0, needsRead: false });
const UNREAD = json({ surfaceable: 0, needsRead: true });
{
  const d = new Driven();
  await d.tick(10);
  const k = d.relay.counts();
  c("liveness:ten empty ticks send ten polls and no read, and wake and frame nothing",
    k.polls === 10 && k.emptyPolls === 10 && d.h.wakes === 0 && d.frames.length === 0 && reads(d.svc) === 0 && json(d.relay.pending()) === NONE, k);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w1", kind: "deferred", body: "cadence body", live: true, released: false });
  d.svc.readDelayMs = 80;
  d.readMs = 20;
  await d.tick();
  await sleep(120);
  c("liveness:an unread deferred offer whose cadence read times out wakes and frames nothing, and is not an empty poll",
    d.h.wakes === 0 && d.frames.length === 0 && d.relay.counts().readTimeouts === 1 && d.relay.counts().emptyPolls === 0 && json(d.relay.pending()) === UNREAD, d.relay.counts());
  d.svc.readDelayMs = 0;
  await d.tick();
  c("liveness:the next tick reads again, wakes once, and the host's frame carries the item",
    d.h.wakes === 1 && d.frames.length === 1 && d.frames[0]!.includes("[item w1] cadence body") && reads(d.svc) === 2, { wakes: d.h.wakes, frames: d.frames });
  await d.tick(3);
  c("liveness:the verdict is reported once, and later ticks read and wake nothing",
    d.u.data[0]!.resolved?.outcome === "delivered" && d.u.data[0]!.resolved.by === "client" && d.h.wakes === 1 && d.frames.length === 1 && reads(d.svc) === 2, d.u.data[0]);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w2", kind: "deferred", body: "after the hook timeout", live: true, released: false });
  d.u.control.push({ id: "k1", class: "priority", text: "first" });
  d.svc.readDelayMs = 80;
  d.readMs = 20;
  d.hookMs = 20;
  await d.tick();
  await sleep(120);
  c("liveness:when the cadence and hook-path reads both time out, the control wake's frame carries the control item alone",
    d.h.wakes === 1 && d.frames.length === 1 && d.frames[0]!.includes("[priority k1]") && !d.frames[0]!.includes("[item w2]") && d.relay.counts().readTimeouts === 2, { k: d.relay.counts(), frames: d.frames });
  d.svc.readDelayMs = 0;
  await d.tick();
  c("liveness:the next tick reads again, wakes once more, and a new frame carries the item",
    d.h.wakes === 2 && d.frames.length === 2 && d.frames[1]!.includes("[item w2] after the hook timeout") && !d.frames[1]!.includes("[priority k1]"), d.frames);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w3", kind: "deferred", body: "judged twice", live: true, released: false });
  d.verdicts.push(false);
  await d.tick();
  c("liveness:an undelivered deferred frame needs a read again, and its turn end asks for no frame",
    d.h.wakes === 1 && d.frames.length === 1 && json(d.relay.pending()) === UNREAD, d.relay.pending());
  await d.tick();
  c("liveness:the next tick reads again, wakes once more, and the new frame carries the repeat label",
    d.h.wakes === 2 && d.frames.length === 2 && d.frames[1]!.includes("[item w3] judged twice") && d.frames[1]!.includes(REPEAT) && reads(d.svc) === 2, d.frames);
  await d.tick();
  c("liveness:only the later verdict delivers it", d.u.data[0]!.resolved?.outcome === "delivered" && d.frames.length === 2, d.u.data[0]);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w4", kind: "notice", text: "judged twice", live: true, released: false });
  d.verdicts.push(false);
  await d.tick();
  c("liveness:an undelivered notice stays surfaceable, so the host's turn-end level check frames it again with no new wake",
    d.h.wakes === 1 && d.frames.length === 2 && d.frames[1]!.includes(REPEAT) && json(d.relay.pending()) === NONE && reads(d.svc) === 0, { wakes: d.h.wakes, frames: d.frames });
  await d.tick(3);
  c("liveness:the notice is delivered once, and later ticks wake nothing", d.u.data[0]!.resolved?.outcome === "delivered" && d.h.wakes === 1 && d.frames.length === 2, d.u.data[0]);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w5", kind: "notice", text: "late while paused", live: true, released: false });
  let release!: () => void;
  d.svc.hold = new Promise<void>((r) => { release = r; });
  const ticking = d.tick();
  await sleep(0);
  d.relay.pause();
  release();
  await ticking;
  c("liveness:a late poll reply applied while paused holds its wake, and nothing is pending or framed",
    d.h.wakes === 0 && d.relay.counts().heldWakes === 1 && d.frames.length === 0 && json(d.relay.pending()) === NONE && d.relay.status().held === "w5", d.relay.counts());
  await d.tick(2);
  c("liveness:ticks while paused send nothing", d.svc.requests.length === 1 && d.h.wakes === 0);
  d.relay.resume();
  await d.serve();
  c("liveness:resume releases one wake, and the host's frame carries the item",
    d.h.wakes === 1 && d.frames.length === 1 && d.frames[0]!.includes("[item w5] late while paused"), d.frames);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w6", kind: "deferred", body: "read while paused", live: true, released: false });
  d.svc.readDelayMs = 30;
  const ticking = d.tick();
  await sleep(10);
  d.relay.pause();
  await ticking;
  c("liveness:a wake-path read that lands while paused holds its wake", d.h.wakes === 0 && d.relay.counts().heldWakes === 1 && d.frames.length === 0, d.relay.counts());
  d.relay.resume();
  await d.serve();
  c("liveness:resume releases it once, and the frame carries the item", d.h.wakes === 1 && d.frames.length === 1 && d.frames[0]!.includes("[item w6] read while paused"), d.frames);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w7", kind: "deferred", body: "read across a refresh", live: true, released: false });
  await d.relay.poll(1000);
  d.svc.readDelayMs = 30;
  const reading = d.relay.prepare(1000, "wake");
  d.svc.contract = "sha256:contract-2";
  await d.relay.poll(1000);
  await reading;
  c("liveness:a read that lands while discovery is pending holds its wake", d.relay.status().refreshing && d.h.wakes === 0 && d.relay.counts().heldWakes === 1, d.relay.counts());
  d.svc.contract = PIN.contract;
  d.relay.setPin({ ...PIN });
  await d.serve();
  c("liveness:the identical re-verified pin releases it once, and the frame carries the item",
    d.h.wakes === 1 && d.frames.length === 1 && d.frames[0]!.includes("[item w7] read across a refresh"), d.frames);
}
{
  const d = new Driven();
  d.u.data.push({ id: "w8", kind: "notice", text: "withdrawn while paused", live: true, released: false });
  let release!: () => void;
  d.svc.hold = new Promise<void>((r) => { release = r; });
  const ticking = d.tick();
  await sleep(0);
  d.relay.pause();
  release();
  await ticking;
  d.relay.setPin({ ...PIN, lifecycleUid: "u2" });
  d.relay.resume();
  await d.serve();
  c("liveness:a held wake is dropped with its generation, and resume wakes nothing", d.relay.counts().heldWakes === 1 && d.h.wakes === 0 && d.frames.length === 0, d.relay.counts());
}
{
  const d = new Driven();
  d.u.data.push({ id: "w9", kind: "deferred", body: "never read", live: true, released: false });
  d.svc.readDelayMs = 80;
  d.readMs = 20;
  await d.tick();
  await sleep(120);
  const sent = d.svc.requests.length;
  d.relay.pause();
  await d.tick(3);
  c("liveness:a paused relay retries nothing", d.svc.requests.length === sent && d.h.wakes === 0);
  d.relay.resume();
  d.relay.setPin({ inactive: "host has no relay verdict" });
  await d.tick(3);
  c("liveness:an inactive relay retries nothing", d.svc.requests.length === sent && d.h.wakes === 0);
  d.relay.setPin({ ...PIN, lifecycleUid: "u2" });
  d.svc.readDelayMs = 0;
  await d.tick(3);
  c("liveness:after a new lifecycle UID the old item is never read again",
    reads(d.svc) === 1 && d.h.wakes === 0 && d.frames.length === 0 && d.svc.requests.length === sent + 3, { reads: reads(d.svc), sent: d.svc.requests.length });
}

// ── the level predicate and its edges, called directly ────────────────────────────────────────
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "p1", kind: "deferred", body: "p1", live: true, released: false });
  u.control.push({ id: "q1", class: "priority", text: "p" }, { id: "q2", class: "notice", text: "n" });
  await relay.poll(1000);
  c("pending:control and an unread offer count every control item and need a read", h.wakes === 1 && json(relay.pending()) === json({ surfaceable: 2, needsRead: true }), relay.pending());
  await relay.prepare(1000, "hook");
  const k = relay.counts();
  const before = json(relay.status());
  for (let i = 0; i < 50; i++) relay.pending();
  c("pending:is pure: fifty calls change no count and no status", json(relay.counts()) === json(k) && json(relay.status()) === before, relay.counts());
  const f = look(relay)!;
  c("pending:a hook-path read wakes nothing, and surfaceable equals what the frame carries",
    h.wakes === 1 && relay.pending().surfaceable === f.frame.refs.length && f.frame.refs.length === 3 && f.text.includes("[item p1] p1") && reads(svc) === 1, f.frame.refs);
  relay.commit(f.frame, false);
  c("pending:after an undelivered verdict, control stays surfaceable and the deferred item needs a read", json(relay.pending()) === json({ surfaceable: 2, needsRead: true }), relay.pending());
  relay.pause();
  c("pending:a paused relay has nothing pending", json(relay.pending()) === NONE);
  relay.resume();
  c("pending:resume shows the same level again, and a resume with no held wake wakes nothing", json(relay.pending()) === json({ surfaceable: 2, needsRead: true }) && h.wakes === 1, relay.pending());
  svc.contract = "sha256:contract-2";
  await relay.poll(1000);
  c("pending:a refreshing relay has nothing pending", relay.status().refreshing && json(relay.pending()) === NONE);
  relay.setPin({ inactive: "host has no relay verdict" });
  c("pending:an inactive relay has nothing pending", json(relay.pending()) === NONE);
}
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "p2", kind: "deferred", body: "p2", live: true, released: false });
  await relay.poll(1000);
  svc.readDelayMs = 30;
  await Promise.all([relay.prepare(1000, "wake"), relay.prepare(1000, "wake")]);
  c("pending:two concurrent wake-path prepares send one read and wake once", reads(svc) === 1 && h.wakes === 1 && json(relay.pending()) === json({ surfaceable: 1, needsRead: false }), { reads: reads(svc), wakes: h.wakes });
}
{
  const { h, relay, u } = fresh();
  u.data.push({ id: "p3", kind: "deferred", body: "p3", live: true, released: false });
  await relay.poll(1000);
  u.data[0]!.live = false;
  await relay.prepare(1000, "wake");
  c("pending:a read answered withdrawn wakes nothing and leaves nothing pending", h.wakes === 0 && json(relay.pending()) === NONE && relay.status().unreported === "p3");
}
{
  const { svc, h, relay, u } = fresh();
  u.data.push({ id: "p4", kind: "deferred", body: "p4", live: true, released: false });
  await relay.poll(1000);
  svc.readDelayMs = 30;
  const reading = relay.prepare(1000, "wake");
  await sleep(0);
  relay.setPin({ ...PIN, grantId: "g2" });
  await reading;
  c("pending:a read reply after the pin changed is discarded and wakes nothing", h.wakes === 0 && relay.counts().staleReplies === 1 && json(relay.pending()) === NONE, relay.counts());
}
{
  const d = new Driven();
  d.u.data.push({ id: "p5", kind: "deferred", body: "released, then withdrawn", live: true, released: false });
  await d.relay.poll(1000);
  await d.relay.prepare(1000, "wake");
  c("pending:the service counts the item released at the read, before any verdict", d.u.data[0]!.released && d.u.data[0]!.resolved === undefined && d.h.wakes === 1);
  d.u.data[0]!.live = false;
  await d.relay.poll(1000);
  await d.serve();
  c("pending:text in hand is dropped unsurfaced when a later poll finds it withdrawn, and the wake's frame finds nothing",
    json(d.relay.pending()) === NONE && d.frames.length === 0 && d.relay.status().unreported === "p5", { pending: d.relay.pending(), status: d.relay.status() });
}
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "p6", kind: "notice", text: "judged while paused", live: true, released: false });
  await relay.poll(1000);
  const f = look(relay)!;
  relay.pause();
  relay.commit(f.frame, true);
  c("pending:a true verdict for a frame issued before the pause is kept", relay.status().unreported === "p6" && relay.counts().staleCommits === 0 && json(relay.pending()) === NONE);
  relay.resume();
  await relay.poll(1000);
  c("pending:after resume it is reported once, from the client", u.data[0]!.resolved?.outcome === "delivered" && u.data[0]!.resolved.by === "client" && svc.requests.length === 2, u.data[0]);
}

// ── bounds and closed replies ─────────────────────────────────────────────────────────────────
const scripted = (replies: unknown[]) => {
  const sent: Record<string, unknown>[] = [];
  const h = mkHost(async (call) => {
    sent.push(call.args);
    return { ok: true, data: replies.shift() };
  });
  const relay = new ServiceRelay(h);
  relay.setPin(PIN);
  return { h, relay, sent };
};
const sized = (shape: Record<string, unknown>, field: string, size: number) => {
  const base = bytes({ ...shape, [field]: "" });
  return { ...shape, [field]: "x".repeat(size - base) };
};
{
  const control = Array.from({ length: 16 }, (_, i) => sized({ id: `m${i}`, class: "notice" }, "text", 1024));
  const data = sized({ id: "dmax", kind: "notice", repeat: false }, "text", 65_536);
  const reply = { control, data };
  const { h, relay } = scripted([reply]);
  await relay.poll(1000);
  c("bounds:sixteen maximum control items and a maximum data item fit under the 96 KiB cap and are accepted",
    bytes(reply) <= 98_304 && control.every((x) => bytes(x) === 1024) && bytes(data) === 65_536 && relay.status().controlWaiting === 16 && relay.status().held === "dmax" && relay.counts().malformed === 0 && h.wakes === 1,
    { size: bytes(reply), status: relay.status() });
}
/** `prefixHeld` names the deferred offer an accepted first reply leaves held; the refused reply after it
 *  must change nothing. Neither an unread offer nor a refused reply wakes. */
const refusedWhole = async (name: string, replies: unknown[], prefixHeld?: string) => {
  const { h, relay } = scripted(replies);
  for (let i = 0; i <= (prefixHeld === undefined ? 0 : 1); i++) await relay.poll(1000);
  const k = relay.counts();
  c(name, k.malformed === 1 && h.wakes === 0 && relay.status().held === prefixHeld && h.logs.some((l) => l.startsWith("malformed relay.poll reply")), { k, status: relay.status(), logs: h.logs });
};
await refusedWhole("closed:seventeen control items are refused whole", [{ control: Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, class: "notice", text: "t" })) }]);
await refusedWhole("closed:a control item over 1024 bytes is refused, never cut", [{ control: [sized({ id: "big", class: "notice" }, "text", 1025)] }]);
await refusedWhole("closed:an unknown reply field is refused", [{ control: [], extra: true }]);
await refusedWhole("closed:held state answering a data request is refused", [{ control: [], held: { id: "h1", state: "live" } }]);
await refusedWhole("closed:a control id outside the id grammar is refused", [{ control: [{ id: "bad id", class: "notice", text: "t" }] }]);
await refusedWhole("closed:text with a lone surrogate is refused", [{ control: [{ id: "s1", class: "notice", text: "\uD800" }] }]);
await refusedWhole("closed:a deferred item carrying text is refused", [{ control: [], data: { id: "dd", kind: "deferred", text: "t", repeat: false } }]);
await refusedWhole("closed:a data item answering a held request is refused", [
  { control: [], data: { id: "h2", kind: "deferred", repeat: false } },
  { control: [], held: { id: "h2", state: "live" }, data: { id: "h3", kind: "notice", text: "t", repeat: false } },
], "h2");
await refusedWhole("closed:a held request answered without its held state is refused", [
  { control: [], data: { id: "h4", kind: "deferred", repeat: false } },
  { control: [] },
], "h4");
await refusedWhole("closed:held state naming another item is refused", [
  { control: [], data: { id: "h5", kind: "deferred", repeat: false } },
  { control: [], held: { id: "other", state: "live" } },
], "h5");
{
  const { svc, relay, u } = fresh();
  u.data.push({ id: "big1", kind: "deferred", body: "z".repeat(70_000), live: true, released: false });
  await relay.poll(1000);
  await relay.prepare(1000, "wake");
  c("bounds:an oversized body is withdrawn by the service at read, never cut, and never surfaced",
    u.data[0]!.resolved?.reason === "too-large" && u.data[0]!.resolved.by === "service" && look(relay) === undefined && relay.status().unreported === "big1", u.data[0]?.resolved);
  await relay.poll(1000);
  c("bounds:the client's skipped then loses the race and resyncs", relay.counts().resyncs === 1 && svc.requests.filter((r) => r.command === "relay.read").length === 1);
}

// ── census over every request and every frame this suite produced ────────────────────────────
c("census:no relay body ever names an identity",
  everySent.length > 0 && everySent.every((s) => s.command === "relay.read"
    ? json(Object.keys(s.args)) === json(["item"])
    : Object.keys(s.args).every((k) => ["contract", "control", "data", "held"].includes(k))),
  everySent.find((s) => !Object.keys(s.args).every((k) => ["contract", "control", "data", "held", "item"].includes(k))));
c("census:every request carried a finite deadline", everySent.every((s) => Number.isFinite(s.deadlineMs) && s.deadlineMs > 0));
c("census:no connector-written line in any frame claims a stop",
  surfaced.length > 0 && surfaced.every((t) => t.split("\n").filter((l) => !l.startsWith("[") && !l.startsWith(" ")).every((l) => !/stop/i.test(l))),
  surfaced.length);

console.log(`service-relay smoke: ${ok} passed, ${fail} failed (owned in-process fake; not registered, not production-wired)`);
if (fail > 0) process.exit(1);
