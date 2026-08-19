/**
 * v0.4 endpoint control-surface grammar smoke (broker-free) — the committed, CI-wired contract
 * for SPEC §13.2: builds every request/reply/plane form against the spec's literal subject
 * table, round-trips the parser, and proves the boundaries hold:
 *   - explicit discrimination (mode-token set vs owner tokens), never arity counting;
 *   - exact arity — a token too many or too few parses as NOTHING (null = MUST NOT handle);
 *   - fail-loud builders (bad labels, `_` in endpoint labels, short nonces, oversize subjects);
 *   - the bijective endpoint-name `.` ↔ `_` token mapping;
 *   - reply derivation copies the caller triple + nonce from the parsed (authenticated) request;
 *   - the retired v0 `ctl.>`/`control.>` planes do not parse on this surface.
 *
 * Run: pnpm smoke:ep-grammar   (no broker; part of smoke:ci)
 */
import {
  epRequestSubject, epReplySubject, deriveReplySubject, parseEpSubject,
  epeSubject, epfSubject, epjSubject, eptSubject, eprSubject, epcSubject, epwSubject, epsSubject,
  epClassQueueGroup, epServeFilter, epInstanceServeFilter, epCallerReplyFilter, epResponderReplyPattern,
  endpointToken, endpointNameOf, EP_AUTHZ_MODES, PROTOCOL_VERSION_V04,
  type EpCaller, type ParsedEp,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false); } catch { c(n, true); } };

const UID = "a".repeat(26);
const UID2 = "b".repeat(28);
const IID = "c".repeat(26);
const NONCE = "N".repeat(22);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

// ── endpoint-name token mapping (bijective; DNS-shaped labels; no `_`) ──
c("single-label token", endpointToken("manager") === "manager");
c("reverse-DNS token", endpointToken("com.acme.deploy") === "com_acme_deploy");
c("token inverse", endpointNameOf("com_acme_deploy") === "com.acme.deploy");
c("round-trip is identity", endpointNameOf(endpointToken("a-b.c0.d")) === "a-b.c0.d");
throws("label with _ rejected", () => endpointToken("com.ac_me"));
throws("leading dash rejected", () => endpointToken("-acme.com"));
throws("trailing dash rejected", () => endpointToken("acme-.com"));
throws("empty label rejected", () => endpointToken("acme..com"));
throws("uppercase rejected", () => endpointToken("Acme.com"));

// ── request forms against the §13.2 table (literal expected strings) ──
const base = { endpoint: "manager", command: "spawn", caller, nonce: NONCE } as const;
const one = epRequestSubject("demo", { route: { mode: "one" }, ...base });
c("class untargeted = 10 tokens, literal", one === `cotal.demo.ep.one.manager.spawn.u_abc.worker.${UID}.${NONCE}`);
const oneSelf = epRequestSubject("demo", { route: { mode: "one" }, ...base, target: { mode: "self" } });
c("class self = 11 tokens", oneSelf === `cotal.demo.ep.one.manager.spawn.self.u_abc.worker.${UID}.${NONCE}`);
const oneOwner = epRequestSubject("demo", { route: { mode: "one" }, ...base, target: { mode: "owner", tOwner: "u_abc" } });
c("class owner = 12 tokens", oneOwner === `cotal.demo.ep.one.manager.spawn.owner.u_abc.u_abc.worker.${UID}.${NONCE}`);
const oneHandle = epRequestSubject("demo", { route: { mode: "one" }, ...base, target: { mode: "handle", tOwner: "u_t", tActor: "svc", tUid: UID2 } });
c("class handle = 14 tokens", oneHandle === `cotal.demo.ep.one.manager.spawn.handle.u_t.svc.${UID2}.u_abc.worker.${UID}.${NONCE}`);
const all = epRequestSubject("demo", { route: { mode: "all" }, ...base });
c("scatter mode token", all === `cotal.demo.ep.all.manager.spawn.u_abc.worker.${UID}.${NONCE}`);
const inst = epRequestSubject("demo", { route: { mode: "inst", instanceId: IID }, ...base, target: { mode: "ledger", tOwner: "u_t" } });
c("instance targeted", inst === `cotal.demo.ep.inst.manager.${IID}.spawn.ledger.u_t.u_abc.worker.${UID}.${NONCE}`);
const reply = epReplySubject("demo", { endpoint: "manager", instanceId: IID, epoch: 3, caller, nonce: NONCE });
c("reply = 11 tokens, literal", reply === `cotal.demo.ep.reply.manager.${IID}.3.u_abc.worker.${UID}.${NONCE}`);

// ── parse round-trips ──
const pOne = parseEpSubject(one);
c("untargeted parses: no target, caller triple, nonce",
  pOne?.plane === "request" && pOne.route === "one" && pOne.endpoint === "manager" && pOne.command === "spawn"
  && pOne.target === null && pOne.caller.owner === "u_abc" && pOne.caller.actor === "worker" && pOne.caller.uid === UID && pOne.nonce === NONCE);
const pHandle = parseEpSubject(oneHandle);
c("handle parses: full pinned target triple",
  pHandle?.plane === "request" && pHandle.target?.mode === "handle" && pHandle.target.tOwner === "u_t"
  && pHandle.target.tActor === "svc" && pHandle.target.tUid === UID2);
const pInst = parseEpSubject(inst);
c("instance parses: instanceId + ledger target",
  pInst?.plane === "request" && pInst.route === "inst" && pInst.instanceId === IID
  && pInst.target?.mode === "ledger" && pInst.target.tOwner === "u_t");
const pReply = parseEpSubject(reply);
c("reply parses: instance triple + epoch + caller + nonce",
  pReply?.plane === "reply" && pReply.instanceId === IID && pReply.epoch === 3 && pReply.nonce === NONCE);
c("reverse-DNS endpoint decodes on parse",
  (parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "com.acme.deploy", command: "run", caller, nonce: NONCE })) as { endpoint?: string })?.endpoint === "com.acme.deploy");

// ── explicit discrimination: owner tokens vs mode tokens (disjoint sets, never arity) ──
const localCaller: EpCaller = { owner: "local", actor: "a1", uid: UID };
const pLocal = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller: localCaller, nonce: NONCE }));
c("caller owner `local` after command parses as UNTARGETED (not a mode token)",
  pLocal?.plane === "request" && pLocal.target === null && pLocal.caller.owner === "local");
for (const m of EP_AUTHZ_MODES) c(`mode token "${m}" never parses as a caller owner`, (() => {
  // <command>.<mode> with a target block short a caller: exact arity makes every misuse null.
  const forged = `cotal.demo.ep.one.manager.spawn.${m}.u_x.a.${UID}`;
  const p = parseEpSubject(forged);
  return p === null || (p.plane === "request" && p.target !== null);
})());

// ── exact arity: a token too many/too few parses as nothing ──
c("one token short → null", parseEpSubject(`cotal.demo.ep.one.manager.spawn.u_abc.worker.${UID}`) === null);
c("one token extra → null", parseEpSubject(`${one}.extra`) === null);
c("self + spurious target token → null", parseEpSubject(`cotal.demo.ep.one.manager.spawn.self.u_t.u_abc.worker.${UID}.${NONCE}`) === null);
c("handle with 2 target tokens → null", parseEpSubject(`cotal.demo.ep.one.manager.spawn.handle.u_t.svc.u_abc.worker.${UID}.${NONCE}`) === null);
c("reply with extra token → null", parseEpSubject(`${reply}.x`) === null);
c("reply with non-numeric epoch → null", parseEpSubject(`cotal.demo.ep.reply.manager.${IID}.x3.u_abc.worker.${UID}.${NONCE}`) === null);
c("reply with a beyond-2^53 epoch → null (parse mirrors the build-side safe-integer bound)",
  parseEpSubject(`cotal.demo.ep.reply.manager.${IID}.9007199254740993.u_abc.worker.${UID}.${NONCE}`) === null);
c("unknown route token → null", parseEpSubject(`cotal.demo.ep.two.manager.spawn.u_abc.worker.${UID}.${NONCE}`) === null);

// ── retired v0 planes do not parse here ──
c("retired ctl plane → null", parseEpSubject("cotal.demo.ctl.manager.u_abc.worker") === null);
c("retired control plane → null", parseEpSubject("cotal.demo.control.spawn.u_abc.worker") === null);
c("v0 chat plane → null on this surface", parseEpSubject("cotal.demo.chat.u_abc.worker.general") === null);

// ── reply derivation from the authenticated request (confused-deputy boundary) ──
if (pInst?.plane !== "request") throw new Error("the inst fixture must parse as a request subject");
const derived = deriveReplySubject("demo", pInst, { instanceId: IID, epoch: 7 });
c("derived reply copies caller triple + nonce, pins responder identity",
  derived === `cotal.demo.ep.reply.manager.${IID}.7.u_abc.worker.${UID}.${NONCE}`);

// ── serve/read filters (§13.9 shapes; exact arity, no grammar-escaping tails) ──
c("class queue group = endpoint token", epClassQueueGroup("com.acme.deploy") === "com_acme_deploy");
c("class serve filter", epServeFilter("demo", "one", "manager") === "cotal.demo.ep.one.manager.>");
c("scatter serve filter", epServeFilter("demo", "all", "manager") === "cotal.demo.ep.all.manager.>");
c("instance serve filter", epInstanceServeFilter("demo", "manager", IID) === `cotal.demo.ep.inst.manager.${IID}.>`);
c("caller reply filter is its own rail, exact arity",
  epCallerReplyFilter("demo", caller) === `cotal.demo.ep.reply.*.*.*.u_abc.worker.${UID}.*`);
c("responder reply pattern pins instance triple + epoch",
  epResponderReplyPattern("demo", "manager", IID, 3) === `cotal.demo.ep.reply.manager.${IID}.3.*.*.*.*`);

// ── endpoint-published planes ──
const ev = epeSubject("demo", "manager", IID, 2, ["ev", "cluster1", "started"]);
c("event subject", ev === `cotal.demo.epe.manager.${IID}.2.ev.cluster1.started`);
const pEv = parseEpSubject(ev);
c("event parses", pEv?.plane === "event" && pEv.epoch === 2 && pEv.topic.join(".") === "ev.cluster1.started");
const fact = epfSubject("demo", "manager", ["dec", "u_abc", "worker", UID, "req1"]);
c("fact subject", fact === `cotal.demo.epf.manager.dec.u_abc.worker.${UID}.req1`);
c("fact parses", parseEpSubject(fact)?.plane === "fact");
const j = epjSubject("demo", { endpoint: "manager", command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, caller });
c("journal subject (targeted, no nonce)", j === `cotal.demo.epj.manager.spawn.owner.u_abc.u_abc.worker.${UID}`);
const pJ = parseEpSubject(j);
c("journal parses with target + caller", pJ?.plane === "journal" && pJ.target?.mode === "owner" && pJ.caller.uid === UID);
c("journal with trailing nonce-like token → null", parseEpSubject(`${j}.${NONCE}`) === null);
const t = eptSubject("demo", "manager", IID, 4, "t1", "armed");
c("timer subject", t === `cotal.demo.ept.manager.${IID}.4.t1.armed`);
const pT = parseEpSubject(t);
c("timer parses", pT?.plane === "timer" && pT.phase === "armed" && pT.timerId === "t1");
c("timer with unknown phase → null", parseEpSubject(`cotal.demo.ept.manager.${IID}.4.t1.boom`) === null);
const r = eprSubject("demo", "manager", IID, 5, "svc", ["status"]);
c("record subject", r === `cotal.demo.epr.manager.${IID}.5.svc.status`);
c("record parses", (parseEpSubject(r) as { kind?: string })?.kind === "svc");
const digest = "e".repeat(64);
c("contract subject", epcSubject("demo", digest) === `cotal.demo.epc.${digest}`);
c("contract parses", (parseEpSubject(`cotal.demo.epc.${digest}`) as { digestHex?: string })?.digestHex === digest);
throws("contract digest with sha256: prefix rejected", () => epcSubject("demo", `sha256:${digest}`));
const w = epwSubject("demo", "manager", "builds", { ...caller, id: "req9" });
c("work subject", w === `cotal.demo.epw.manager.builds.u_abc.worker.${UID}.req9`);
const pW = parseEpSubject(w);
c("work parses acceptance identity", pW?.plane === "work" && pW.acceptance.id === "req9" && pW.acceptance.uid === UID);
const s = epsSubject("demo", "manager", "s1", 1, "in");
c("session subject", s === `cotal.demo.eps.manager.s1.1.in`);
const pS = parseEpSubject(s);
c("session parses", pS?.plane === "session" && pS.dir === "in");
c("session bad dir → null", parseEpSubject("cotal.demo.eps.manager.s1.1.sideways") === null);

// ── fail-loud builder bounds ──
throws("short nonce rejected", () => epRequestSubject("demo", { route: { mode: "one" }, ...base, nonce: "short" }));
throws("bad command rejected", () => epRequestSubject("demo", { route: { mode: "one" }, ...base, command: "Bad_Cmd" }));
throws("bad lifecycle uid rejected", () => epRequestSubject("demo", { route: { mode: "one" }, ...base, caller: { ...caller, uid: "UPPER" } }));
throws("negative epoch rejected", () => epReplySubject("demo", { endpoint: "manager", instanceId: IID, epoch: -1, caller, nonce: NONCE }));
throws("oversize subject rejected (1024-byte cap)", () => epeSubject("demo", "manager", IID, 1, Array.from({ length: 40 }, () => "t".repeat(30))));
throws("empty topic rejected", () => epeSubject("demo", "manager", IID, 1, []));

// ── protocol marker ──
c("v0.4 marker constant", PROTOCOL_VERSION_V04 === "0.4");

// exhaustiveness sentinel: the union covers exactly the ten planes
const _exhaust = (p: ParsedEp): string => p.plane;
void _exhaust;

console.log(`\nENDPOINT GRAMMAR SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
