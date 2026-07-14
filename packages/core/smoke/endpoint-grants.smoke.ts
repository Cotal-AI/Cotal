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
c("caller bundle: request + journal pub, reply-rail sub",
  bundle.pub.length === 2 && bundle.sub.length === 1 && bundle.sub[0] === epCallerReplyGrantRow("demo", caller));
c("empty capability set mints nothing", JSON.stringify(epCallerGrantRows("demo", [], caller)) === '{"pub":[],"sub":[]}');

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
c("default-deny: no ep rows without capabilities",
  ![...without.pub.allow, ...without.sub.allow].some((r) => r.includes(".ep.") || r.includes(".epj.")));
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
