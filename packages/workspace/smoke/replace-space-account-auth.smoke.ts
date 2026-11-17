/**
 * `replaceSpaceAccountAuth`: one space's existing account record is replaced through the seam and
 * the shared broker record is never written.
 *
 * The backing store is the stock filesystem store over a fresh root holding one broker and two
 * spaces. What a call wrote is read from the store's directory (digest, inode and mtime of every
 * file, before and after) and from a pass-through recorder of the store calls. The broker's first
 * space is the neighbour; the space under test is the second one, the case the full-bundle
 * validation cannot serve.
 *
 *   1. Controls: both spaces compose, `validateSpaceAccountAuth` accepts both, and
 *      `validateSpaceAuth` accepts the first space only.
 *   2. A rotated signing key: exactly the account key is put, the broker record and the neighbour
 *      are neither changed nor rewritten, the stored record validates and mints under the new key.
 *   3. The rollback: the saved record goes back byte for byte and mints under the old key.
 *   4. The same record again is not written.
 *   5. Refusals, each before any write: no broker record, no account record, the legacy monolith
 *      alone, a broker record that is not JSON, blank, or has a corrupt generation, an existing
 *      record that is not JSON, names another space, has no account material or was signed by
 *      another operator, and a replacement that is another account, another operator's, carries
 *      the neighbour's claim, holds a signing seed its claim does not trust or one that does not
 *      match its key, names the neighbour, or is stripped.
 *   6. Failure and read-back: a put that fails before or after landing, a store that drops the
 *      write, a second writer of the account record, and a writer of the broker record. The faults
 *      are injected at the store call; every value still lands in, and is read from, the real store.
 *
 * No broker process. Run: pnpm smoke:space-auth-store   (add --keep-fixture to leave the roots in place)
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, decodeNatsJwt, mintCreds, newIdentity, rotateDataAccountSigningKey,
  validateSpaceAccountAuth, validateSpaceAuth, type BrokerAuth, type SecretStore, type SpaceAccountAuth,
} from "@cotal-ai/core";
import { BROKER_AUTH_KEY, getSpaceAuth, putSpaceAuth, replaceSpaceAccountAuth, SPACE_AUTH_KEY, spaceAccountKey } from "../src/auth-paths.js";
import { workspaceSecretStore } from "../src/secret-store-fs.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

interface FileFact { sha: string; ino: bigint; mtimeNs: bigint }
function snapshot(dir: string): Map<string, FileFact> {
  const out = new Map<string, FileFact>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = lstatSync(p, { bigint: true });
      out.set(relative(dir, p), { sha: createHash("sha256").update(readFileSync(p)).digest("hex"), ino: st.ino, mtimeNs: st.mtimeNs });
    }
  };
  walk(dir);
  return out;
}
/** Every file that was added, removed, changed or rewritten in place between two readings. */
function touched(before: Map<string, FileFact>, after: Map<string, FileFact>): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((f) => {
    const a = before.get(f), b = after.get(f);
    return !a || !b || a.sha !== b.sha || a.ino !== b.ino || a.mtimeNs !== b.mtimeNs;
  }).sort();
}

/** The real store with every call listed. `put` can be replaced to inject a fault at the call. */
function recorded(store: SecretStore, put?: (key: string, value: string) => Promise<void>) {
  const calls: string[] = [];
  const wrapped: SecretStore = {
    identity: store.identity,
    get: async (k) => { calls.push(`get ${k}`); return store.get(k); },
    put: async (k, v) => { calls.push(`put ${k}`); return put ? put(k, v) : store.put(k, v); },
    create: async (k, v) => { calls.push(`create ${k}`); return store.create(k, v); },
    delete: async (k) => { calls.push(`delete ${k}`); return store.delete(k); },
  };
  return { store: wrapped, calls, writes: () => calls.filter((c) => !c.startsWith("get ")) };
}

const record = (a: SpaceAccountAuth): SpaceAccountAuth => ({ space: a.space, account: a.account });
/** The issuer of a credential minted from what the store holds for `space`, signature verified. */
async function mintedIssuer(store: SecretStore, space: string): Promise<{ iss?: string; account?: string }> {
  const auth = await getSpaceAuth(store, space);
  const creds = await mintCreds(auth!, newIdentity(), "observer");
  const jwt = /-----BEGIN NATS USER JWT-----\s*([A-Za-z0-9._-]+)\s*------END NATS USER JWT------/.exec(creds)?.[1] ?? "";
  const claims = decodeNatsJwt<{ iss?: string; nats?: { issuer_account?: string } }>(jwt);
  return { iss: claims.iss, account: claims.nats?.issuer_account };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keepFixture = process.argv.includes("--keep-fixture");
const roots: string[] = [];
const newRoot = () => { const r = mkdtempSync(join(tmpdir(), "cotal-replace-account-")); roots.push(r); return r; };

try {
  const broker = await createBrokerAuth("first");
  const first = await createSpaceAccountAuth(broker, "first");
  const target = await createSpaceAccountAuth(broker, "target");
  const otherBroker = await createBrokerAuth("other");
  const foreignTarget = await createSpaceAccountAuth(otherBroker, "target");
  const secrets = [broker.operator.seed, broker.operator.jwt, broker.sys.jwt, otherBroker.operator.seed,
    ...[first, target, foreignTarget].flatMap((a) => [a.account.seed, a.account.jwt, a.account.signingSeed])];

  const root = newRoot();
  const dir = join(root, ".cotal");
  const store = workspaceSecretStore(root);
  await putSpaceAuth(store, composeSpaceAuth(broker, first));
  await putSpaceAuth(store, composeSpaceAuth(broker, target));
  const targetKey = spaceAccountKey("target"), firstKey = spaceAccountKey("first");
  const brokerRaw = (await store.get(BROKER_AUTH_KEY))!;
  const firstRaw = (await store.get(firstKey))!;
  const originalRaw = (await store.get(targetKey))!;
  const storedBroker = JSON.parse(brokerRaw) as BrokerAuth;

  /** A refusal: the message, no stored secret in it, no store write, no file touched. */
  const refuses = async (name: string, at: { root: string; store: SecretStore }, replacement: unknown, fragment: string) => {
    const atDir = join(at.root, ".cotal");
    const before = snapshot(atDir);
    const rec = recorded(at.store);
    let msg: string | undefined;
    try { await replaceSpaceAccountAuth(rec.store, replacement as SpaceAccountAuth); } catch (e) { msg = (e as Error).message; }
    check(`${name}: refused`, msg !== undefined && msg.includes(fragment), msg ?? "did not throw");
    check(`${name}: the message carries no stored secret`, msg !== undefined && secrets.every((s) => !msg!.includes(s)));
    check(`${name}: nothing was written`, rec.writes().length === 0 && touched(before, snapshot(atDir)).length === 0, rec.writes());
  };

  console.log("\n1. controls");
  check("both spaces compose from the store", (await getSpaceAuth(store, "first"))?.account.pub === first.account.pub && (await getSpaceAuth(store, "target"))?.account.pub === target.account.pub);
  check("validateSpaceAccountAuth accepts the first space", validateSpaceAccountAuth(storedBroker, JSON.parse(firstRaw), "first").account.pub === first.account.pub);
  check("validateSpaceAccountAuth accepts the second space", validateSpaceAccountAuth(storedBroker, JSON.parse(originalRaw), "target").account.pub === target.account.pub);
  check("validateSpaceAuth accepts the first space", validateSpaceAuth(await getSpaceAuth(store, "first"), "first").space === "first");
  let fullOnSecond = "accepted";
  try { validateSpaceAuth(await getSpaceAuth(store, "target"), "target"); } catch (e) { fullOnSecond = (e as Error).message; }
  check("validateSpaceAuth refuses the second space for its operator name", fullOnSecond.includes("operator JWT name does not match space"), fullOnSecond);
  check("a credential minted before the change is issued by the original signing key", (await mintedIssuer(store, "target")).iss === target.account.signingPub);

  console.log("\n2. a rotated signing key");
  const rotated = await rotateDataAccountSigningKey((await getSpaceAuth(store, "target"))!);
  check("the rotation changed the signing key and kept the account", rotated.account.signingPub !== target.account.signingPub && rotated.account.pub === target.account.pub);
  await sleep(20);
  let before = snapshot(dir);
  let rec = recorded(store);
  await replaceSpaceAccountAuth(rec.store, record(rotated));
  let after = snapshot(dir);
  check("the only store write is one put of the account key", JSON.stringify(rec.writes()) === JSON.stringify([`put ${targetKey}`]), rec.writes());
  check("the only file touched is the account record", JSON.stringify(touched(before, after)) === JSON.stringify([targetKey]), touched(before, after));
  check("the account record's bytes changed", before.get(targetKey)!.sha !== after.get(targetKey)!.sha);
  check("the broker record is byte-equal and was not rewritten", (await store.get(BROKER_AUTH_KEY)) === brokerRaw && before.get(BROKER_AUTH_KEY)!.ino === after.get(BROKER_AUTH_KEY)!.ino && before.get(BROKER_AUTH_KEY)!.mtimeNs === after.get(BROKER_AUTH_KEY)!.mtimeNs);
  check("the neighbour's record is byte-equal and was not rewritten", (await store.get(firstKey)) === firstRaw && before.get(firstKey)!.ino === after.get(firstKey)!.ino);
  check("no file was added or removed", JSON.stringify([...before.keys()].sort()) === JSON.stringify([...after.keys()].sort()));
  const storedRotated = JSON.parse((await store.get(targetKey))!) as SpaceAccountAuth;
  check("the stored record is the replacement", JSON.stringify(storedRotated) === JSON.stringify(record(rotated)));
  check("the stored record validates against the stored broker record", validateSpaceAccountAuth(storedBroker, storedRotated, "target").account.signingPub === rotated.account.signingPub);
  const claim = decodeNatsJwt<{ nats?: { signing_keys?: unknown[] } }>(storedRotated.account.jwt);
  check("the stored claim trusts the new key and not the old one", JSON.stringify(claim.nats?.signing_keys) === JSON.stringify([rotated.account.signingPub]));
  let issuer = await mintedIssuer(store, "target");
  check("a credential minted from the store is issued by the new key for the same account", issuer.iss === rotated.account.signingPub && issuer.account === target.account.pub, issuer);
  issuer = await mintedIssuer(store, "first");
  check("the neighbour still mints under its own key", issuer.iss === first.account.signingPub && issuer.account === first.account.pub, issuer);

  console.log("\n3. the rollback");
  await sleep(20);
  before = snapshot(dir);
  rec = recorded(store);
  await replaceSpaceAccountAuth(rec.store, JSON.parse(originalRaw) as SpaceAccountAuth);
  after = snapshot(dir);
  check("the only store write is one put of the account key", JSON.stringify(rec.writes()) === JSON.stringify([`put ${targetKey}`]), rec.writes());
  check("the only file touched is the account record", JSON.stringify(touched(before, after)) === JSON.stringify([targetKey]), touched(before, after));
  check("the record is byte-equal to the one saved before the change", (await store.get(targetKey)) === originalRaw);
  check("the broker record and the neighbour are byte-equal", (await store.get(BROKER_AUTH_KEY)) === brokerRaw && (await store.get(firstKey)) === firstRaw);
  check("the restored record validates", validateSpaceAccountAuth(storedBroker, JSON.parse((await store.get(targetKey))!), "target").account.signingPub === target.account.signingPub);
  issuer = await mintedIssuer(store, "target");
  check("a credential minted from the store is issued by the original key again", issuer.iss === target.account.signingPub && issuer.account === target.account.pub, issuer);

  console.log("\n4. the same record again");
  await sleep(20);
  before = snapshot(dir);
  rec = recorded(store);
  await replaceSpaceAccountAuth(rec.store, JSON.parse(originalRaw) as SpaceAccountAuth);
  check("a byte-equal replacement makes no store write", rec.writes().length === 0, rec.writes());
  check("a byte-equal replacement touches no file", touched(before, snapshot(dir)).length === 0);

  console.log("\n5. refusals before any write");
  const here = { root, store };
  const absent = await createSpaceAccountAuth(broker, "absent");
  await refuses("a space with no account record", here, record(absent), "has no account record");
  check("no record was created for that space", (await store.get(spaceAccountKey("absent"))) === undefined);
  await refuses("a replacement that names no space", here, { account: rotated.account }, "names no space");
  await refuses("another account for the same space", here, record(await createSpaceAccountAuth(broker, "target")), "a different account");
  await refuses("another operator's account for the same space", here, record(foreignTarget), "not a valid account record of this broker");
  await refuses("the neighbour's claim in this space's record", here, { space: "target", account: { ...rotated.account, jwt: first.account.jwt } }, "account JWT subject, issuer, or type");
  const stray = await createSpaceAccountAuth(broker, "target");
  await refuses("a signing seed the claim does not trust", here, { space: "target", account: { ...rotated.account, signingSeed: stray.account.signingSeed, signingPub: stray.account.signingPub } }, "not trusted as an unscoped signer");
  await refuses("a signing seed that does not match its key", here, { space: "target", account: { ...rotated.account, signingSeed: stray.account.signingSeed } }, "account.signingSeed does not match");
  await refuses("this account under the neighbour's name", here, { space: "first", account: rotated.account }, "account JWT name does not match space");
  await refuses("a stripped replacement", here, { space: "target", account: { ...rotated.account, seed: "" } }, "account.seed must be a non-empty string");
  await refuses("a replacement with no account", here, { space: "target" }, "account must be an object");

  const rawRoot = async (values: Record<string, string>) => {
    const r = newRoot(), s = workspaceSecretStore(r);
    for (const [k, v] of Object.entries(values)) await s.put(k, v);
    return { root: r, store: s as SecretStore };
  };
  await refuses("no broker record", await rawRoot({ [targetKey]: originalRaw }), record(rotated), "no broker trust record");
  await refuses("the legacy monolith alone", await rawRoot({ [SPACE_AUTH_KEY]: JSON.stringify(composeSpaceAuth(broker, target)) }), record(rotated), "no broker trust record");
  await refuses("a broker record that is not JSON", await rawRoot({ [BROKER_AUTH_KEY]: "{not json", [targetKey]: originalRaw }), record(rotated), "is not valid JSON");
  await refuses("a blank broker record", await rawRoot({ [BROKER_AUTH_KEY]: JSON.stringify({ operator: { seed: "", jwt: "" }, sys: { pub: "", jwt: "" } }), [targetKey]: originalRaw }), record(rotated), "blank or incomplete");
  await refuses("a broker record with a corrupt generation", await rawRoot({ [BROKER_AUTH_KEY]: JSON.stringify({ ...storedBroker, gen: "1" }), [targetKey]: originalRaw }), record(rotated), "system-account generation");
  await refuses("an existing record that is not JSON", await rawRoot({ [BROKER_AUTH_KEY]: brokerRaw, [targetKey]: "{not json" }), record(rotated), "is not valid JSON");
  await refuses("an existing record that names another space", await rawRoot({ [BROKER_AUTH_KEY]: brokerRaw, [targetKey]: firstRaw }), record(rotated), "does not name space");
  await refuses("an existing record with no account material", await rawRoot({ [BROKER_AUTH_KEY]: brokerRaw, [targetKey]: JSON.stringify({ space: "target" }) }), record(rotated), "failed trust-chain validation");
  await refuses("an existing record another operator signed", await rawRoot({ [BROKER_AUTH_KEY]: brokerRaw, [targetKey]: JSON.stringify(record(foreignTarget)) }), record(rotated), "failed trust-chain validation");

  console.log("\n6. failure and read-back");
  const diskIs = async (raw: string) => (await store.get(targetKey)) === raw && readFileSync(join(dir, targetKey), "utf8") === raw;
  const rotatedRaw = JSON.stringify(record(rotated), null, 2);
  const brokerUntouched = async () => (await store.get(BROKER_AUTH_KEY)) === brokerRaw && (await store.get(firstKey)) === firstRaw;

  // A put that fails before anything lands. The backend's own text must not reach the message.
  const backendText = `backend text ${target.account.signingSeed}`;
  rec = recorded(store, async () => { throw new Error(backendText); });
  let error: Error | undefined;
  try { await replaceSpaceAccountAuth(rec.store, record(rotated)); } catch (e) { error = e as Error; }
  check("a failed put is reported as a failed put", error?.message.includes(`the put of ${targetKey} failed`) === true, error?.message);
  check("the store's own error is the cause and its text is not in the message", (error?.cause as Error | undefined)?.message === backendText && error!.message.includes(backendText) === false);
  check("the previous record is still in the store", await diskIs(originalRaw));
  check("the broker record and the neighbour are byte-equal", await brokerUntouched());
  rec = recorded(store);
  await replaceSpaceAccountAuth(rec.store, record(rotated));
  check("the retry writes the account key once and the record is the replacement", JSON.stringify(rec.writes()) === JSON.stringify([`put ${targetKey}`]) && await diskIs(rotatedRaw), rec.writes());

  // A put that lands and then reports a failure.
  rec = recorded(store, async (k, v) => { await store.put(k, v); throw new Error("reported after landing"); });
  error = undefined;
  try { await replaceSpaceAccountAuth(rec.store, JSON.parse(originalRaw) as SpaceAccountAuth); } catch (e) { error = e as Error; }
  check("a put that lands and then fails is reported as a failed put", error?.message.includes(`the put of ${targetKey} failed`) === true, error?.message);
  check("the replacement is in the store", await diskIs(originalRaw));
  rec = recorded(store);
  await replaceSpaceAccountAuth(rec.store, JSON.parse(originalRaw) as SpaceAccountAuth);
  check("the retry finds the record in place and writes nothing", rec.writes().length === 0, rec.writes());

  // A store that accepts the put and does not keep it.
  rec = recorded(store, async () => {});
  error = undefined;
  try { await replaceSpaceAccountAuth(rec.store, record(rotated)); } catch (e) { error = e as Error; }
  check("a dropped write is caught by the read-back", error?.message.includes("does not read back as written") === true, error?.message);
  check("the previous record is still in the store", await diskIs(originalRaw));

  // A second writer of the account record during the call.
  rec = recorded(store, async (k, v) => { await store.put(k, v); await store.put(k, originalRaw); });
  error = undefined;
  try { await replaceSpaceAccountAuth(rec.store, record(rotated)); } catch (e) { error = e as Error; }
  check("a second writer of the account record is caught by the read-back", error?.message.includes("does not read back as written") === true, error?.message);
  check("the broker record and the neighbour are byte-equal", await brokerUntouched());

  // A writer of the broker record during the call.
  rec = recorded(store, async (k, v) => { await store.put(k, v); await store.put(BROKER_AUTH_KEY, `${brokerRaw}\n`); });
  error = undefined;
  try { await replaceSpaceAccountAuth(rec.store, record(rotated)); } catch (e) { error = e as Error; }
  check("a writer of the broker record is reported", error?.message.includes("changed during the call") === true, error?.message);
  check("the function itself made no broker write", rec.writes().every((c) => c === `put ${targetKey}`), rec.writes());
  await store.put(BROKER_AUTH_KEY, brokerRaw);

  console.log(`\nREPLACE-SPACE-ACCOUNT-AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", e);
  process.exitCode = 1;
} finally {
  if (keepFixture) console.log(`fixtures kept: ${roots.join(" ")}`);
  else for (const r of roots) rmSync(r, { recursive: true, force: true });
}
