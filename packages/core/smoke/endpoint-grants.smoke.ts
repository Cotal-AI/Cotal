/**
 * v0.4 endpoint grant-grammar smoke (broker-free) — the capability → allow-list contract of
 * SPEC §13.9's caller and serve rows, checked two ways:
 *   1. the row BUILDERS against the matrix's literal forms (request publish, journal append,
 *      reply rails, queue-qualified class serve, egress pins);
 *   2. the MINTED CREDENTIAL: an agent JWT minted with `endpointCapabilities` carries exactly
 *      those rows (decoded and compared), none without them (default-deny), and the mint
 *      fails loud without a lifecycle UID.
 *
 * Run: pnpm smoke:ep-grants   (no broker; part of smoke:ci)
 */
import {
  createSpaceAuth, mintCreds, newIdentity,
  epRequestGrantRows, epJournalGrantRow, epCallerReplyGrantRow, epGoalProgressGrantRow,
  epCallerGrantRows, epServeSubscribeRows, epServePublishRows, epServeGrantRows,
  epBaselineGrantRows, spawnCallerCapabilities, operatorInstrumentCapabilities, permissionsFor,
  type EpCapability, type EpCaller,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false); } catch { c(n, true); } };

const UID = "u".repeat(26);
const IID = "i".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "cli", uid: UID };

// ── caller rows against the §13.9 matrix forms ──
const spawnCap: EpCapability = { endpoint: "manager", command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, journal: true };
c("request row: class one, owner mode, caller-pinned, nonce-only wildcard",
  epRequestGrantRows("demo", spawnCap, caller).join("|")
  === `cotal.demo.ep.one.manager.spawn.owner.u_abc.u_abc.cli.${UID}.*`);
c("request rows: routes + instance pin",
  epRequestGrantRows("demo", { endpoint: "manager", command: "status", routes: ["one", "all"], instanceId: IID }, caller).join("|")
  === `cotal.demo.ep.one.manager.status.u_abc.cli.${UID}.*|cotal.demo.ep.all.manager.status.u_abc.cli.${UID}.*|cotal.demo.ep.inst.manager.${IID}.status.u_abc.cli.${UID}.*`);
c("journal row: same authz block, no nonce",
  epJournalGrantRow("demo", spawnCap, caller) === `cotal.demo.epj.manager.spawn.owner.u_abc.u_abc.cli.${UID}`);
c("reply-rail read row: own rail, exact arity",
  epCallerReplyGrantRow("demo", caller) === `cotal.demo.ep.reply.*.*.*.u_abc.cli.${UID}.*`);
c("per-goal progress row: caller identity in-subject",
  epGoalProgressGrantRow("demo", "manager", caller) === `cotal.demo.epe.manager.*.*.goal.u_abc.cli.${UID}.>`);
const handleCap: EpCapability = { endpoint: "manager", command: "attach", target: { mode: "handle", tOwner: "u_t", tActor: "svc", tUid: "h".repeat(26) } };
c("handle row builds through epRequestGrantRows (the redemption path) with the full triple pinned",
  epRequestGrantRows("demo", handleCap, caller)[0]
  === `cotal.demo.ep.one.manager.attach.handle.u_t.svc.${"h".repeat(26)}.u_abc.cli.${UID}.*`);
c("any mode accepts a wildcard target owner (operator/admin mint policy)",
  epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "any", tOwner: "*" } }, caller)[0]
  === `cotal.demo.ep.one.manager.stop.any.*.u_abc.cli.${UID}.*`);
throws("owner mode never mints a wildcard target owner",
  () => epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "owner", tOwner: "*" } }, caller));
throws("owner mode never mints a foreign target owner (pinned to the caller's own owner)",
  () => epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "owner", tOwner: "u_victim" } }, caller));
throws("child mode has the same caller-owner ceiling",
  () => epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "child", tOwner: "u_victim" } }, caller));
throws("grant rows reject grammar-breaking target owners (a smuggled '>' must not widen the row)",
  () => epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "ledger", tOwner: "u_evil.>" } }, caller));
throws("caller owner/actor tokens are grammar-validated in grant rows too",
  () => epRequestGrantRows("demo", spawnCap, { owner: "u_abc", actor: "c.li", uid: UID }));
throws("standing caller bundle refuses a handle-mode capability (redemption-minted only)",
  () => epCallerGrantRows("demo", [handleCap], caller));
const bundle = epCallerGrantRows("demo", [spawnCap], caller);
c("caller bundle: request + journal pub, reply-rail + own-goal-progress sub (spawn is goal-bearing, P2 item 2)",
  bundle.pub.length === 2 && bundle.sub.length === 2
  && bundle.sub[0] === epCallerReplyGrantRow("demo", caller)
  && bundle.sub[1] === epGoalProgressGrantRow("demo", "manager", caller));
c("empty capability set mints nothing", JSON.stringify(epCallerGrantRows("demo", [], caller)) === '{"pub":[],"sub":[]}');

// ── the Appendix-B baseline set ──
const baseline = epBaselineGrantRows("demo", caller);
c("baseline: the ONE wildcard-endpoint form is describe-only, caller pinned, nonce-tailed",
  baseline.pub[0] === `cotal.demo.ep.one.*.describe.u_abc.cli.${UID}.*`);
c("baseline: delivery join/leave/list untargeted + manager stop self-mode + the ONE epc-subject-scoped store fetch, nothing else",
  baseline.pub.length === 6
  && baseline.pub.includes(`cotal.demo.ep.one.delivery.join.u_abc.cli.${UID}.*`)
  && baseline.pub.includes(`cotal.demo.ep.one.delivery.leave.u_abc.cli.${UID}.*`)
  && baseline.pub.includes(`cotal.demo.ep.one.delivery.list.u_abc.cli.${UID}.*`)
  && baseline.pub.includes(`cotal.demo.ep.one.manager.stop.self.u_abc.cli.${UID}.*`)
  // §13.7 store fetch rides the baseline (describe answers digests; a caller that may describe
  // may fetch the schemas those digests name) — EXACTLY the epc-subject-scoped Direct Get form,
  // never the bare/stream-wide row, and no epc PUBLISH row.
  && baseline.pub.includes("$JS.API.DIRECT.GET.EPC_demo.cotal.demo.epc.>")
  && baseline.pub.every((r) => !r.startsWith("cotal.demo.epc.")),
  JSON.stringify(baseline.pub));
c("baseline: the reply rail is ALWAYS granted (no capability required)",
  baseline.sub.length === 1 && baseline.sub[0] === epCallerReplyGrantRow("demo", caller));
c("baseline: no journal rows (the baseline is ephemeral request forms only)",
  baseline.pub.every((r) => !r.includes(".epj.")));
c("the spawn set: spawn is UNTARGETED (virgin child); despawn/attach/input ride owner-mode (no owner-stop synonym of despawn); define-persona + inspect ride untargeted (the 1c table's connector reads)",
  spawnCallerCapabilities("u_abc").length === 6
  && epCallerGrantRows("demo", spawnCallerCapabilities("u_abc"), caller).pub.join("|")
  === `cotal.demo.ep.one.manager.spawn.u_abc.cli.${UID}.*|cotal.demo.ep.one.manager.despawn.owner.u_abc.u_abc.cli.${UID}.*|cotal.demo.ep.one.manager.attach.owner.u_abc.u_abc.cli.${UID}.*|cotal.demo.ep.one.manager.input.owner.u_abc.u_abc.cli.${UID}.*|cotal.demo.ep.one.manager.define-persona.u_abc.cli.${UID}.*|cotal.demo.ep.one.manager.inspect.u_abc.cli.${UID}.*`);
// The operator INSTRUMENT rollups (the 1c grant-migration table's admin row): the privileged
// instrument is read + create + persona only (structurally barred from cross-agent reach, like its
// ctl row); the admin instrument adds ANY-mode despawn/attach/input (tOwner "*": operator-policy-mintable
// only, §13.2 - the broker grant IS the tier boundary) and the untargeted `manager.admin` family.
c("the privileged instrument set: reads + spawn + define-persona, NOTHING targeted",
  operatorInstrumentCapabilities("privileged").length === 6
  && operatorInstrumentCapabilities("privileged").every((cap) => cap.target === undefined)
  && operatorInstrumentCapabilities("privileged").map((cap) => cap.command).join(",") === "status,ps,inspect,models,spawn,define-persona");
const adminCaps = operatorInstrumentCapabilities("admin");
c("the admin instrument set adds any-mode despawn/attach/input + the manager.admin family",
  adminCaps.length === 17
  && adminCaps.filter((cap) => cap.target?.mode === "any").map((cap) => cap.command).join(",") === "despawn,attach,input"
  && adminCaps.filter((cap) => cap.target?.mode === "any").every((cap) => (cap.target as { tOwner?: string }).tOwner === "*")
  && ["purge", "launch", "resume-preserved", "commit-resume", "finalize-resume", "prepare-preservation", "commit-preservation", "abort-preservation"].every((cmd) => adminCaps.some((cap) => cap.command === cmd && cap.target === undefined)));
c("an any-mode instrument row spans the target owner (grant `*`), pinned to the caller triple",
  epCallerGrantRows("demo", adminCaps.filter((cap) => cap.target?.mode === "any" && cap.command === "despawn"), caller).pub.join("|")
  === `cotal.demo.ep.one.manager.despawn.any.*.u_abc.cli.${UID}.*`);

// ── serve rows against the §13.9 matrix forms ──
c("serve subscribe: queue-qualified class rail + plain scatter + exact instance, per command",
  epServeSubscribeRows("demo", "com.acme.deploy", IID, "run").join("|")
  === `cotal.demo.ep.one.com_acme_deploy.run.> com_acme_deploy|cotal.demo.ep.all.com_acme_deploy.run.>|cotal.demo.ep.inst.com_acme_deploy.${IID}.run.>`);
c("serve publish: reply attribution pin + events + timer schedule-only + record ingress, all epoch-pinned",
  epServePublishRows("demo", "manager", IID, 5).join("|")
  === `cotal.demo.ep.reply.manager.${IID}.5.*.*.*.*|cotal.demo.epe.manager.${IID}.5.>|cotal.demo.ept.manager.${IID}.5.*.schedule|cotal.demo.epr.manager.${IID}.5.>`);
const serve = epServeGrantRows("demo", { endpoint: "manager", instanceId: IID, epoch: 5, ephemeralCommands: ["spawn"] });
c("serve bundle: 3 sub rows per ephemeral command incl. the DERIVED describe, plus the own timer-fire read; 4 pub rows",
  serve.sub.length === 7 && serve.pub.length === 4);
c("the timer-fire read row is the own instance's, epoch-pinned (§13.9 Timer fire consume)",
  serve.sub.includes(`cotal.demo.ept.manager.${IID}.5.*.fire`));
// A journal-only endpoint has no ephemeral (rail-served) commands, but still serves mandatory
// describe (§13.7): the bundle is describe rails + the own timer-fire read only.
const journalOnly = epServeGrantRows("demo", { endpoint: "manager", instanceId: IID, epoch: 5, ephemeralCommands: [] });
c("a journal-only serve bundle (no ephemeral commands) still grants the DERIVED describe rails + timer-fire",
  journalOnly.sub.length === 4 && journalOnly.sub.some((r) => r.includes(".describe.")) && journalOnly.sub.includes(`cotal.demo.ept.manager.${IID}.5.*.fire`) && journalOnly.pub.length === 4);
throws("serve bundle refuses an EXPLICIT describe (reserved, derived in this one seam)",
  () => epServeGrantRows("demo", { endpoint: "manager", instanceId: IID, epoch: 5, ephemeralCommands: ["spawn", "describe"] }));
c("no serve rail row crosses commands (no bare cross-command tail)",
  serve.sub.filter((r) => !r.endsWith(".fire")).every((r) => r.includes(".spawn.") || r.includes(".describe.")));

// ── the minted credential carries exactly these rows (permissionsFor wiring) ──
const auth = await createSpaceAuth("epg");
const decode = (creds: string): { pub: { allow: string[] }; sub: { allow: string[] } } => {
  const jwt = /BEGIN NATS USER JWT-+\s+(\S+)/.exec(creds)![1];
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(Buffer.from(payload, "base64").toString()) as { nats: { pub: { allow: string[] }; sub: { allow: string[] } } }).nats;
};
const withCaps = decode(await mintCreds(auth, newIdentity(), "agent", {
  principal: { owner: "u_abc", actor: "cli" },
  endpointCapabilities: [spawnCap],
  lifecycleUid: UID,
}));
c("minted JWT carries the request row", withCaps.pub.allow.includes(`cotal.epg.ep.one.manager.spawn.owner.u_abc.u_abc.cli.${UID}.*`));
c("minted JWT carries the journal row", withCaps.pub.allow.includes(`cotal.epg.epj.manager.spawn.owner.u_abc.u_abc.cli.${UID}`));
c("minted JWT carries the reply-rail read", withCaps.sub.allow.includes(`cotal.epg.ep.reply.*.*.*.u_abc.cli.${UID}.*`));
const without = decode(await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" }, lifecycleUid: UID }));
const BASELINE_PUB = [
  `cotal.epg.ep.one.*.describe.u_abc.cli.${UID}.*`,
  `cotal.epg.ep.one.delivery.join.u_abc.cli.${UID}.*`,
  `cotal.epg.ep.one.delivery.leave.u_abc.cli.${UID}.*`,
  `cotal.epg.ep.one.delivery.list.u_abc.cli.${UID}.*`,
  `cotal.epg.ep.one.manager.stop.self.u_abc.cli.${UID}.*`,
];
c("no-capability mint carries EXACTLY the Appendix-B baseline ep rows (describe-all + delivery join/leave/list + self stop), nothing wider",
  JSON.stringify(without.pub.allow.filter((r) => r.includes(".ep.") || r.includes(".epj.")).sort())
  === JSON.stringify([...BASELINE_PUB].sort()),
  JSON.stringify(without.pub.allow.filter((r) => r.includes(".ep."))));
c("no-capability mint carries the baseline reply-rail read (and only that ep sub row)",
  without.sub.allow.filter((r) => r.includes(".ep.")).join("|") === `cotal.epg.ep.reply.*.*.*.u_abc.cli.${UID}.*`);
c("no-capability mint carries NO journal rows and NO owner/child/ledger-mode rows",
  ![...without.pub.allow].some((r) => r.includes(".epj.") || r.includes(".owner.") || r.includes(".child.") || r.includes(".ledger.")));
const withSpawn = decode(await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" }, lifecycleUid: UID, capabilities: ["spawn"] }));
c("the spawn capability adds UNTARGETED manager.spawn + owner-mode despawn/attach/input to the minted JWT (no owner-stop synonym)",
  withSpawn.pub.allow.includes(`cotal.epg.ep.one.manager.spawn.u_abc.cli.${UID}.*`)
  && ["despawn", "attach", "input"].every((cmd) => withSpawn.pub.allow.includes(`cotal.epg.ep.one.manager.${cmd}.owner.u_abc.u_abc.cli.${UID}.*`))
  && !withSpawn.pub.allow.includes(`cotal.epg.ep.one.manager.stop.owner.u_abc.u_abc.cli.${UID}.*`));
c("without the spawn capability none of the owner-mode lifecycle rows appear",
  !without.pub.allow.some((r) => r.includes(".owner.")));
// C7 (critic/distsys/engineer-5): one credential names ONE incarnation on the caller rail. Through
// mintCreds, principalOf collapses opts.lifecycleUid INTO pr.lifecycleUid, so they cannot diverge;
// the risk lives on the PUBLIC permissionsFor seam (the IdP-adapter path), where pr and opts are
// separate. A divergent opts.lifecycleUid must FAIL LOUD there, never mint two reply rails.
const OTHER_UID = "z".repeat(26);
const prC7 = { owner: "u_abc", actor: "cli", connId: "connid01234567", lifecycleUid: UID };
throws("permissionsFor fails loud when opts.lifecycleUid disagrees with the principal's (no dual-uid caller rail, C7)",
  () => permissionsFor("agent", "demo", prC7 as never, { endpointCapabilities: [spawnCap], lifecycleUid: OTHER_UID }));
const agreed = permissionsFor("agent", "demo", prC7 as never, { endpointCapabilities: [spawnCap], lifecycleUid: UID });
c("permissionsFor with an AGREEING opts.lifecycleUid mints, and every caller-rail row carries the ONE uid",
  agreed.pub.allow.concat(agreed.sub.allow).filter((r: string) => r.includes(".ep.")).every((r: string) => r.includes(`.${UID}.`) || r.includes(`.${UID}`))
  && !agreed.pub.allow.some((r: string) => r.includes(OTHER_UID)));
let threw = false;
try {
  await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" }, endpointCapabilities: [spawnCap] });
} catch (e) {
  threw = (e as Error).message.includes("lifecycleUid");
}
c("mint without a lifecycleUid fails loud", threw);
let threwHandle = false;
try {
  await mintCreds(auth, newIdentity(), "agent", {
    principal: { owner: "u_abc", actor: "cli" },
    endpointCapabilities: [handleCap],
    lifecycleUid: UID,
  });
} catch (e) {
  threwHandle = (e as Error).message.includes("redemption-minted");
}
c("mint refuses a standing handle capability end-to-end", threwHandle);

console.log(`\nENDPOINT GRANTS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
