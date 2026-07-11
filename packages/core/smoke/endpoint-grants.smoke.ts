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
c("handle capability pins the full redemption triple",
  epRequestGrantRows("demo", { endpoint: "manager", command: "attach", target: { mode: "handle", tOwner: "u_t", tActor: "svc", tUid: "h".repeat(26) } }, caller)[0]
  === `cotal.demo.ep.one.manager.attach.handle.u_t.svc.${"h".repeat(26)}.u_abc.cli.${UID}.*`);
c("any mode accepts a wildcard target owner (operator/admin mint policy)",
  epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "any", tOwner: "*" } }, caller)[0]
  === `cotal.demo.ep.one.manager.stop.any.*.u_abc.cli.${UID}.*`);
throws("owner mode never mints a wildcard target owner",
  () => epRequestGrantRows("demo", { endpoint: "manager", command: "stop", target: { mode: "owner", tOwner: "*" } }, caller));
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
const serve = epServeGrantRows("demo", { endpoint: "manager", instanceId: IID, epoch: 5, commands: ["spawn", "describe"] });
c("serve bundle: 3 sub rows per command, 4 pub rows", serve.sub.length === 6 && serve.pub.length === 4);
throws("serve bundle refuses zero commands", () => epServeGrantRows("demo", { endpoint: "manager", instanceId: IID, epoch: 5, commands: [] }));
c("no serve row crosses commands (no bare cross-command tail)",
  serve.sub.every((r) => r.includes(".spawn.") || r.includes(".describe.")));

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
const without = decode(await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" } }));
c("default-deny: no ep rows without capabilities",
  ![...without.pub.allow, ...without.sub.allow].some((r) => r.includes(".ep.") || r.includes(".epj.")));
let threw = false;
try {
  await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "u_abc", actor: "cli" }, endpointCapabilities: [spawnCap] });
} catch (e) {
  threw = (e as Error).message.includes("lifecycleUid");
}
c("mint without a lifecycleUid fails loud", threw);

console.log(`\nENDPOINT GRANTS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
