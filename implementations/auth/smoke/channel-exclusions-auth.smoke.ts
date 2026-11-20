/**
 * Channel exclusions on the user-auth path (SPEC §9).
 *
 * Broker-free:
 *  A. the actor ledger stores a row with exclusions as `{ allow, exclude }` at version 2, keeps a
 *     row without them at version 1 byte-for-byte, and a reader that predates exclusions refuses
 *     the version 2 row by its version and its object lists by their shape;
 *  B. the user-mode spawn bound is exact with exclusions applied, names and patterns, at authorship
 *     and at every agent exchange, and its repair line keeps the spawner's exclusions;
 *  C. a run's frozen delegation bounds its helpers with the exclusions it recorded, and a remote
 *     launch target's object-form lists become the ledger row's lists and exclusions;
 *  D. the chat parent pin digest commits to the parent row's exclusions, and a chat session's lists
 *     are contained in the parent grant with its exclusions applied;
 *  E. `cotal actor grant` refuses a read exclusion and checks a post exclusion;
 *  F. the callout mints an exclusion only with the connecting node's version at or above the floor.
 *
 * Live (nats-server on PATH): G. a credential the real callout mints from a version 2 ledger row
 * refuses the excluded read and post on the broker, and the sibling under the same wildcard works.
 *
 * Run: pnpm smoke:channel-exclusions:auth
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type ConnectionOptions, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  calloutReaderId, canonicalJson, chatSubject, createEndpointStreams, createSpaceAuth, isReachable, mintLifecycleUid,
  registry, serverConfig, standaloneConnectOpts, type Command, type LifecycleMapping, type ParsedArgs,
} from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, findInteractiveActor, findManagedActor,
  generateSigningKey, grantActor, grantManagedActor, ledgerAclResolver, ledgerAuthorizeAgentExchange, managedActorLedgerDir,
  newActorToken, openAuthAuthorityPlane, startAuthCallout, actorLedgerDir,
} from "../src/index.js";
import { assertWithinRunDelegation, type ActorRow } from "../src/ledger.js";
import { launchTargetGrant } from "../src/managed-agent-enrollment.js";
import { assertChatListsContained, assertChatParentPinCurrent, buildChatParentPin } from "../src/chat-parent-pin.js";
import { openAuthorityClient } from "../src/authority-client.js";
import type { ValidatedUserToken } from "../src/token.js";
import "../src/commands.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusal = (fn: () => unknown): string => {
  try { fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

const OWNER = `u_${"a".repeat(26)}`;
const custody = { kind: "foreground" as const };
const tmp = mkdtempSync(join(tmpdir(), "cotal-exclusions-auth-"));
const managed = (dir: string, row: Omit<ActorRow, "grantedAt" | "custody" | "tokenHash" | "lifecycleUid" | "owner"> & { owner?: string }) =>
  grantManagedActor(dir, { owner: OWNER, ...row, tokenHash: newActorToken().tokenHash, lifecycleUid: mintLifecycleUid(), custody });

try {
  // ---- A. the ledger row ----------------------------------------------------------------------
  console.log("A. ledger rows");
  {
    const dir = join(tmp, "a");
    const wrote = grantManagedActor(dir, { owner: OWNER, actor: "plain", scope: [], allowSubscribe: ["team.>"], allowPublish: ["team.a"], tokenHash: "0".repeat(64), lifecycleUid: mintLifecycleUid(), custody });
    const plainFile = readFileSync(join(managedActorLedgerDir(dir), `${OWNER}.plain.json`), "utf8");
    // The writer before exclusions: `JSON.stringify({ ver: 1, ...row }, null, 2)`.
    check("a row without exclusions is written at version 1, byte-identical to the writer before exclusions",
      plainFile === JSON.stringify({ ver: 1, ...wrote }, null, 2), plainFile);

    const excl = managed(dir, { actor: "excl", scope: [], allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.*.private"] });
    const file = JSON.parse(readFileSync(join(managedActorLedgerDir(dir), `${OWNER}.excl.json`), "utf8")) as Record<string, unknown>;
    check("a row with exclusions is written at version 2", file.ver === 2, file.ver);
    check("each list with exclusions is stored as { allow, exclude }, with no sibling field",
      JSON.stringify(file.allowSubscribe) === JSON.stringify({ allow: ["team.>"], exclude: ["team.secret"] }) &&
        JSON.stringify(file.allowPublish) === JSON.stringify({ allow: ["team.>"], exclude: ["team.*.private"] }) &&
        !("excludeSubscribe" in file) && !("excludePublish" in file), file);
    const back = findManagedActor(dir, OWNER, "excl")!;
    check("the version 2 row reads back as the allow lists plus their exclusions",
      JSON.stringify([back.allowSubscribe, back.excludeSubscribe, back.allowPublish, back.excludePublish]) ===
        JSON.stringify([["team.>"], ["team.secret"], ["team.>"], ["team.*.private"]]) && back.lifecycleUid === excl.lifecycleUid, back);

    // The reader before exclusions, verbatim: refuse any version but 1, then require array lists.
    const oldReader = (raw: Record<string, unknown>): string => {
      if (raw.ver !== 1) return `unknown actor-grant version ${String(raw.ver)} (expected 1)`;
      if (!Array.isArray(raw.scope) || !Array.isArray(raw.allowSubscribe) || !Array.isArray(raw.allowPublish)) return "missing explicit scope/allowSubscribe/allowPublish lists";
      return "";
    };
    check("skew: the old reader refuses the version 2 row by its version", oldReader(file).includes("unknown actor-grant version 2"), oldReader(file));
    check("skew: the old reader refuses the object lists by their shape, even under version 1", oldReader({ ...file, ver: 1 }).includes("lists"));

    const path = join(managedActorLedgerDir(dir), `${OWNER}.excl.json`);
    const original = readFileSync(path, "utf8");
    const rewrite = (raw: Record<string, unknown>) => writeFileSync(path, JSON.stringify(raw, null, 2));
    rewrite({ ...file, ver: 1 });
    check("the reader accepts the object form only in a version 2 row", /missing explicit scope\/allowSubscribe\/allowPublish/.test(refusal(() => findManagedActor(dir, OWNER, "excl"))));
    rewrite({ ...file, allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"] });
    check("a separate exclusion field is refused, never applied or ignored", /separate exclusion field/.test(refusal(() => findManagedActor(dir, OWNER, "excl"))));
    rewrite({ ...file, allowSubscribe: { allow: ["team.>"], exclude: ["other"] } });
    check("a version 2 row whose exclusion removes nothing is refused", /removes nothing/.test(refusal(() => findManagedActor(dir, OWNER, "excl"))));
    writeFileSync(path, original);

    check("the writer refuses an exclusion that removes nothing",
      /removes nothing/.test(refusal(() => managed(dir, { actor: "bad1", scope: [], allowSubscribe: ["team.>"], excludeSubscribe: ["ops"], allowPublish: [] }))));
    check("the writer refuses an exclusion that removes a whole allow entry",
      /excluded in full/.test(refusal(() => managed(dir, { actor: "bad2", scope: [], allowSubscribe: ["team.>", "team.secret"], excludeSubscribe: ["team.secret"], allowPublish: [] }))));
  }

  // ---- B. the user-mode spawn bound -------------------------------------------------------------
  console.log("B. spawn bound");
  {
    const dir = join(tmp, "b");
    grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: [">"], allowPublish: ["team.>"], excludePublish: ["team.secret"] });
    const parent = `${OWNER}.cli`;
    managed(dir, { actor: "spawner", scope: ["spawn"], allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"], parent });
    const under = `${OWNER}.spawner`;
    const child = (actor: string, read: string[], excludeSubscribe: string[] = [], post: string[] = [], excludePublish: string[] = []) => refusal(() =>
      managed(dir, { actor, scope: [], allowSubscribe: read, allowPublish: post, ...(excludeSubscribe.length ? { excludeSubscribe } : {}), ...(excludePublish.length ? { excludePublish } : {}), parent: under }));
    check("(a) a concrete sibling team.a is handed on", child("ca", ["team.a"]) === "");
    check("(b) team.> minus team.secret is handed on", child("cb", ["team.>"], ["team.secret"]) === "");
    check("(c) team.x.> (no exclusion under it) is handed on", child("cc", ["team.x.>"]) === "");
    const d = child("cd", ["team.>"]);
    check("(d) team.> with no exclusion is refused, naming the exclusion it drops", /team\.> \(without excluding team\.secret\)/.test(d) && /minus \[team\.secret\]/.test(d), d);
    check("(d) the refusal says the agent leaves the excluded part out, not that the spawner widen", /leaves out what the spawner's exclusions remove/.test(d) && !/widens the spawner/.test(d), d);
    check("(e) the excluded channel team.secret itself is refused", /read \[team\.secret\]/.test(child("ce", ["team.secret"])));
    check("post: team.> minus team.secret is handed on", child("cp1", [], [], ["team.>"], ["team.secret"]) === "");
    check("post: team.> without the exclusion is refused", /post \[team\.> \(without excluding team\.secret\)\]/.test(child("cp2", [], [], ["team.>"])));
    const wider = child("cw", ["other"]);
    check("a part outside the spawner's allow list prints a widen line that keeps the spawner's exclusions",
      /widens the spawner with `cotal actor grant spawner .*--allow-subscribe 'team\.>,other'.*--exclude-subscribe 'team\.secret' --exclude-publish 'team\.secret'/.test(wider), wider);

    // Pattern exclusions.
    managed(dir, { actor: "pspawner", scope: ["spawn"], allowSubscribe: ["team.>"], excludeSubscribe: ["team.*.private"], allowPublish: [], parent });
    managed(dir, { actor: "qspawner", scope: ["spawn"], allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret.>"], allowPublish: [], parent });
    const pchild = (p: string, actor: string, read: string[], excludeSubscribe: string[] = []) => refusal(() =>
      managed(dir, { actor, scope: [], allowSubscribe: read, allowPublish: [], ...(excludeSubscribe.length ? { excludeSubscribe } : {}), parent: `${OWNER}.${p}` }));
    check("pattern: team.a.> minus team.a.private is handed on under team.> minus team.*.private", pchild("pspawner", "p1", ["team.a.>"], ["team.a.private"]) === "");
    check("pattern: team.a.public is handed on", pchild("pspawner", "p2", ["team.a.public"]) === "");
    check("pattern: team.a.> alone is refused", /team\.a\.> \(without excluding team\.a\.private\)/.test(pchild("pspawner", "p3", ["team.a.>"])));
    check("pattern: team.a.private is refused", pchild("pspawner", "p4", ["team.a.private"]) !== "");
    check("pattern: team.> minus team.secret.> is handed on under the same exclusion", pchild("qspawner", "q1", ["team.>"], ["team.secret.>"]) === "");
    check("pattern: team.> minus the wider team.*.> is handed on", pchild("qspawner", "q2", ["team.>"], ["team.*.>"]) === "");
    check("pattern: team.> minus only team.secret.a is refused", pchild("qspawner", "q3", ["team.>"], ["team.secret.a"]) !== "");

    // A STANDING invariant: an exclusion added to the spawner bites its agents at their next exchange.
    const tok = newActorToken();
    grantManagedActor(dir, { owner: OWNER, actor: "standing", scope: [], allowSubscribe: [], allowPublish: ["team.x.>"], tokenHash: tok.tokenHash, lifecycleUid: mintLifecycleUid(), custody, parent });
    check("an agent within its spawner's post exclusions exchanges", refusal(() => ledgerAuthorizeAgentExchange(dir, OWNER, "standing", tok.actorToken)) === "");
    grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: [">"], allowPublish: ["team.>"], excludePublish: ["team.secret", "team.x.private"] });
    check("once the spawner also excludes team.x.private, the agent's next exchange is refused",
      /CURRENT grant.*post \[team\.x\.> \(without excluding team\.x\.private\)\]/.test(refusal(() => ledgerAuthorizeAgentExchange(dir, OWNER, "standing", tok.actorToken))));
    const ex = (() => { try { return ledgerAuthorizeAgentExchange(dir, OWNER, "cb", ""); } catch { return undefined; } })();
    check("a wrong secret is still the one indistinct refusal", ex === undefined);
  }

  // ---- C. run delegation ------------------------------------------------------------------------
  console.log("C. run delegation");
  {
    const starter = { owner: OWNER, actor: "starter" };
    const delegation = { scope: ["spawn"], allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: ["team.a"] };
    const helper = (allowSubscribe: string[], excludeSubscribe?: string[]) => refusal(() =>
      assertWithinRunDelegation("run1", starter, delegation, { owner: OWNER, actor: "helper", scope: [], allowSubscribe, allowPublish: ["team.a"], ...(excludeSubscribe ? { excludeSubscribe } : {}) }));
    check("a helper that keeps the frozen exclusion is within the run's delegation", helper(["team.>"], ["team.secret"]) === "");
    check("a concrete sibling is within it", helper(["team.b"]) === "");
    check("a helper that drops the frozen exclusion is refused", /run1's starter.*team\.> \(without excluding team\.secret\)/.test(helper(["team.>"])));
    check("the excluded channel is refused", /read \[team\.secret\]/.test(helper(["team.secret"])));

    const target = (t: Record<string, unknown>) => launchTargetGrant({ actor: "helper", ...t });
    check("a launch target's { allow, exclude } lists become the row's lists and exclusions",
      JSON.stringify(target({ subscribe: ["team.a"], allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: { allow: ["team.>"], exclude: ["team.x.*"] } })) ===
        JSON.stringify({ subscribe: ["team.a"], allowSubscribe: ["team.>"], allowPublish: ["team.>"], excludeSubscribe: ["team.secret"], excludePublish: ["team.x.*"] }));
    check("a plain launch target reads its subscribe set as before",
      JSON.stringify(target({ subscribe: ["general"] })) === JSON.stringify({ subscribe: ["general"], allowSubscribe: ["general"], allowPublish: [], excludeSubscribe: [], excludePublish: [] }));
    check("a target that subscribes to a channel its read list excludes is refused",
      /excluded from allowSubscribe/.test(refusal(() => target({ subscribe: ["team.secret"], allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] } }))));
  }

  // ---- D. the chat parent pin -------------------------------------------------------------------
  console.log("D. chat parent pin");
  {
    const dir = join(tmp, "d");
    const row = grantActor(dir, { owner: OWNER, actor: "cli", scope: [], allowSubscribe: ["team.>"], allowPublish: ["team.>"], excludePublish: ["team.secret"] });
    const head = { mapping: { state: "active", owner: OWNER, actor: "cli", lifecycleUid: row.lifecycleUid!, managerInstance: "smoke", processEpoch: 1 } as LifecycleMapping, revision: 7 };
    const pin = buildChatParentPin(row, head);
    const lists = { read: ["team.a"], post: ["team.a"] };
    check("the pin holds against the row it was taken from", refusal(() => assertChatParentPinCurrent(pin, row, head, lists)) === "");
    const { excludePublish: _dropped, ...withoutExclusion } = row;
    check("removing the parent's exclusion moves the digest and ends the session",
      /authority fields changed/.test(refusal(() => assertChatParentPinCurrent(pin, withoutExclusion, head, lists))));
    check("adding a parent exclusion moves the digest too",
      /authority fields changed/.test(refusal(() => assertChatParentPinCurrent(pin, { ...row, excludePublish: ["team.secret", "team.x"] }, head, lists))));
    // A row without exclusions hashes as it did before exclusions existed, so open sessions survive the upgrade.
    const plainPin = buildChatParentPin(withoutExclusion, head);
    const before = createHash("sha256").update(canonicalJson({ owner: OWNER, actor: "cli", scope: [], allowSubscribe: ["team.>"], allowPublish: ["team.>"], lifecycleUid: row.lifecycleUid }), "utf8").digest("hex");
    check("a row without exclusions keeps the digest it had before exclusions", plainPin.rowDigest === before);
    check("a session posting to a sibling is contained", refusal(() => assertChatListsContained(row, { read: [], post: ["team.a"] })) === "");
    check("a session posting to the excluded channel is refused", /post \[team\.secret\]/.test(refusal(() => assertChatListsContained(row, { read: [], post: ["team.secret"] }))));
    check("a session pattern that reaches the excluded channel is refused, never narrowed for it",
      /post \[team\.> \(without excluding team\.secret\)\]/.test(refusal(() => assertChatListsContained(row, { read: [], post: ["team.>"] }))));
  }

  // ---- E. the actor grant command ---------------------------------------------------------------
  console.log("E. actor grant");
  {
    const actorCmd = registry.resolve<Command>("command", "actor");
    const validate = (values: Record<string, unknown>) => refusal(() => actorCmd.validate!({ positionals: ["grant", "alice"], values } as unknown as ParsedArgs));
    const base = { owner: OWNER, scope: "", "allow-subscribe": "team.>", "allow-publish": "team.>" };
    const read = validate({ ...base, "exclude-subscribe": "team.secret" });
    check("an actor grant refuses a read exclusion, saying why", /--exclude-subscribe: .*no read-ACL row/.test(read), read);
    check("an actor grant accepts a post exclusion under its post list", validate({ ...base, "exclude-publish": "team.secret" }) === "");
    check("a post exclusion outside the post list is refused", /--exclude-publish: .*removes nothing/.test(validate({ ...base, "exclude-publish": "ops" })));
    check("--full's `>` post default is the list a post exclusion narrows", validate({ owner: OWNER, full: true, "exclude-publish": "announce" }) === "");
    const dir = join(tmp, "e");
    grantActor(dir, { owner: OWNER, actor: "alice", scope: [], allowSubscribe: ["team.>"], allowPublish: [">"], excludePublish: ["announce"] });
    const stored = JSON.parse(readFileSync(join(actorLedgerDir(dir), `${OWNER}.alice.json`), "utf8")) as Record<string, unknown>;
    check("the interactive row stores the post exclusion at version 2", stored.ver === 2 && JSON.stringify(stored.allowPublish) === JSON.stringify({ allow: [">"], exclude: ["announce"] }));
    check("and reads it back", JSON.stringify(findInteractiveActor(dir, OWNER, "alice")?.excludePublish) === JSON.stringify(["announce"]));
  }

  // ---- F. the callout mint floor ----------------------------------------------------------------
  console.log("F. callout mint floor");
  {
    const dir = join(tmp, "f");
    const space = "exclf";
    const row = managed(dir, { actor: "agent", scope: [], allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"] });
    const plain = managed(dir, { actor: "plain", scope: [], allowSubscribe: ["team.>"], allowPublish: ["team.>"] });
    const token = (actor: string, lifecycleUid: string): ValidatedUserToken => ({
      owner: OWNER, space, scope: [], ver: 1, exp: Math.floor(Date.now() / 1000) + 300,
      act: { owner: OWNER, actor, scope: [], lifecycleUid, credentialId: "f".repeat(26) },
    });
    const mint = calloutPermissions(ledgerAclResolver(dir));
    const readerId = calloutReaderId(`N${"A".repeat(55)}`, 7);
    const t = token("agent", row.lifecycleUid!);
    check("a request without a server version is refused for a grant with exclusions", /reports no version/.test(refusal(() => mint(t, "ibxconnexcl1", readerId))));
    check("a node below the floor (2.12.6) is refused", /"2\.12\.6"/.test(refusal(() => mint(t, "ibxconnexcl2", readerId, "2.12.6"))));
    check("a pre-release of the floor (2.14.0-beta.1) is refused", refusal(() => mint(t, "ibxconnexcl3", readerId, "2.14.0-beta.1")) !== "");
    const perms = mint(t, "ibxconnexcl4", readerId, "2.14.0") as { pub: { allow: string[]; deny?: string[] }; sub: { allow: string[]; deny?: string[] } };
    check("at the floor the read exclusion is a sub deny row", JSON.stringify(perms.sub.deny) === JSON.stringify([chatSubject(space, "*", "*", "team.secret")]), perms.sub.deny);
    check("the post exclusion is a pub deny row on the agent's own subject", perms.pub.deny?.includes(chatSubject(space, OWNER, "agent", "team.secret")) === true);
    check("the sibling read row is still minted", perms.sub.allow.includes(chatSubject(space, "*", "*", "team.>")));
    check("a row without exclusions mints with no version, as before", refusal(() => mint(token("plain", plain.lifecycleUid!), "ibxconnexcl5", readerId)) === "");
  }

  // ---- G. live: the callout on a real broker ----------------------------------------------------
  console.log("G. live callout");
  await live();
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function live(): Promise<void> {
  const PORT = await pickFreePort();
  const SERVERS = `nats://127.0.0.1:${PORT}`;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const enc = (s: string) => new TextEncoder().encode(s);
  const space = `excl-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space);
  const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
  const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const dir = join(brokerDir, "state");
  writeFileSync(join(brokerDir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(brokerDir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
  const srv = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
  const releaseBroker = teardownOnSignal(srv, brokerDir);
  const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
  const quiet = () => {};
  const owner = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
  const conns: NatsConnection[] = [];
  let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
  let setup: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
  let calloutNc: NatsConnection | undefined;
  try {
    let up = false;
    for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
    if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
    setup = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-streams:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
    await createEndpointStreams(await jetstreamManager(setup.nc), new Kvm(setup.nc), space);
    plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet });
    const issuer = createUserTokenIssuer({ issuer: "https://auth.cotal.test", key: await generateSigningKey() });
    calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
    startAuthCallout(calloutNc as never, {
      xkeySeed: callout.xkey.seed,
      authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
      dataAccount, space,
      token: { key: issuer.localKeySet(), issuer: "https://auth.cotal.test" },
      recordIssuance: plane.recordIssuance,
      authorizeActor: plane.authorizeConnect,
      permissionsFor: calloutPermissions(ledgerAclResolver(dir)),
      log: quiet,
    });
    await calloutNc.flush();

    const agent = async (actor: string, lists: Pick<ActorRow, "allowSubscribe" | "allowPublish" | "excludeSubscribe" | "excludePublish">) => {
      const uid = mintLifecycleUid();
      grantManagedActor(dir, { custody, owner, actor, scope: [], ...lists, tokenHash: newActorToken().tokenHash, lifecycleUid: uid });
      const credentialId = await plane!.mintConnectCredential({ owner, actor, lifecycleUid: uid });
      const bearer = await issuer.issue({ owner, space, actor, scope: [], lifecycleUid: uid, credentialId });
      const nc = await connect({ servers: SERVERS, reconnect: false, ...(standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds, tls: false }) as Partial<ConnectionOptions>) });
      conns.push(nc);
      const errors: string[] = [];
      (async () => { for await (const s of nc.status()) if (s.type === "error") errors.push(String((s as { error?: Error }).error?.message ?? JSON.stringify(s))); })().catch(() => {});
      return { nc, errors };
    };
    const reader = await agent("reader", { allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"] });
    check("an agent whose version 2 row carries exclusions connects through the callout (the node's version reached the mint)", true);
    const writer = await agent("writer", { allowSubscribe: [], allowPublish: ["team.>"] });

    const wild: string[] = [];
    reader.nc.subscribe(chatSubject(space, "*", "*", "team.>"), { callback: (_e, m) => { wild.push(m.subject); } });
    let literalErr = "";
    const literal = reader.nc.subscribe(chatSubject(space, "*", "*", "team.secret"), { callback: (e) => { if (e) literalErr = e.message; } });
    literal.closed.then((e) => { if (e) literalErr = e.message; }).catch(() => {});
    await reader.nc.flush();
    await wait(300);
    for (const ch of ["team.a", "team.secret"]) writer.nc.publish(chatSubject(space, owner, "writer", ch), enc(ch));
    await writer.nc.flush();
    await wait(500);
    check("live: the wildcard read delivers the sibling team.a", wild.includes(chatSubject(space, owner, "writer", "team.a")), wild);
    check("live: the wildcard read never delivers the excluded team.secret", !wild.includes(chatSubject(space, owner, "writer", "team.secret")), wild);
    check("live: a literal subscription to the excluded channel is refused by the broker",
      literalErr !== "" || reader.errors.some((e) => /Permissions Violation for Subscription/.test(e) && e.includes("team.secret")), { literalErr, errors: reader.errors });

    const own: string[] = [];
    const watcher = await agent("watcher", { allowSubscribe: ["team.>"], allowPublish: [] });
    watcher.nc.subscribe(chatSubject(space, owner, "reader", "team.>"), { callback: (_e, m) => { own.push(m.subject); } });
    await watcher.nc.flush();
    reader.nc.publish(chatSubject(space, owner, "reader", "team.secret"), enc("excluded"));
    reader.nc.publish(chatSubject(space, owner, "reader", "team.a"), enc("sibling"));
    await reader.nc.flush();
    await wait(500);
    check("live: a post to the excluded channel is refused by the broker",
      !own.includes(chatSubject(space, owner, "reader", "team.secret")) && reader.errors.some((e) => /Permissions Violation for Publish/.test(e) && e.includes("team.secret")), { own, errors: reader.errors });
    check("live: a post to the sibling is delivered", own.includes(chatSubject(space, owner, "reader", "team.a")), own);
  } finally {
    for (const nc of conns) await nc.close().catch(() => {});
    await calloutNc?.close().catch(() => {});
    await plane?.close().catch(() => {});
    await setup?.close().catch(() => {});
    srv.kill();
    await new Promise<void>((resolve) => { if (srv.exitCode !== null || srv.signalCode !== null) resolve(); else { srv.once("exit", () => resolve()); setTimeout(resolve, 3000); } });
    rmSync(brokerDir, { recursive: true, force: true });
    releaseBroker();
  }
}

console.log(`\nchannel-exclusions auth smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
