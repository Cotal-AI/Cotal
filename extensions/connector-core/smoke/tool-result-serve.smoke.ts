/**
 * The managed tool-results serving handoff (no NATS) — run with:
 *   pnpm --dir extensions/connector-core exec tsx smoke/tool-result-serve.smoke.ts
 *
 * Drives the shipped launch-material carrier (materialEnv → readLaunchMaterial) and the shipped
 * serveLaunchedToolResults/serveToolResults refusals: the serving material rides only a static-auth
 * launch, only in the 0600 file; a malformed grant is refused at read; a grant for another space,
 * another endpoint, or another incarnation (a predecessor or a neighbour's agent) is refused before
 * any connection is opened; a launch without material carries no serving material, and the journal
 * a session holds captures nothing until a consent is applied. The live register → serve → holder
 * → retire path needs a broker and the manager, and is NOT exercised here.
 */
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { LAUNCH_MATERIAL_ENV, mintLifecycleUid, readLaunchMaterial, type EpServeGrant } from "@cotal-ai/core";
import { materialEnv } from "../src/launch.js";
import { serveLaunchedToolResults, serveToolResults } from "../src/tool-result-command.js";
import { ToolResultJournal } from "../src/tool-result-journal.js";

let checks = 0;
const SPACE = "team";
const UID = mintLifecycleUid();
const SELF = { owner: "local", actor: "UAGENTNKEY", lifecycleUid: UID };
const grant = (over: Partial<EpServeGrant> = {}): EpServeGrant =>
  ({ space: SPACE, endpoint: "tool-results", instanceId: UID, epoch: 1, owner: "local", ...over }) as EpServeGrant;
const SERVE_CREDS = "-----BEGIN NATS USER JWT-----\nfixture\n------END NATS USER JWT------\n";

// ---- the carrier --------------------------------------------------------------------------------
{
  const env = materialEnv({ creds: "/dev/null", toolResults: { creds: SERVE_CREDS, grant: grant() } });
  const path = env[LAUNCH_MATERIAL_ENV]!;
  assert.ok(path, "the material file exists"); checks++;
  assert.equal(statSync(path).mode & 0o777, 0o600, "the serving creds ride a 0600 file only"); checks++;
  assert.ok(!Object.values(env).some((v) => v.includes("fixture")), "the creds never enter the environment"); checks++;
  const read = readLaunchMaterial(path);
  assert.deepEqual(read.toolResults, { creds: SERVE_CREDS, grant: grant() }, "the session reads back exactly its grant and creds"); checks++;
}
assert.throws(() => materialEnv({ userAuth: { owner: "u_x", actor: "a", sentinelCredsPath: "/s", bearerCmd: ["b"] }, toolResults: { creds: SERVE_CREDS, grant: grant() } }), /only a static-auth launch/); checks++;
assert.throws(() => materialEnv({ toolResults: { creds: SERVE_CREDS, grant: grant() } }), /only a static-auth launch/); checks++;
{
  const plain = materialEnv({ creds: "/dev/null" });
  assert.equal(readLaunchMaterial(plain[LAUNCH_MATERIAL_ENV]!).toolResults, undefined, "an ordinary launch carries no serving material"); checks++;
}

// ---- refusals before any connection --------------------------------------------------------------
const journal = new ToolResultJournal();
assert.equal(journal.sharing, "off", "a session's journal captures nothing before a consent"); checks++;
const unreachable = "nats://127.0.0.1:1";
const serve = (g: EpServeGrant, self = SELF) =>
  serveLaunchedToolResults({ material: { creds: SERVE_CREDS, grant: g }, space: SPACE, servers: unreachable, tls: false, journal, self });
const refusedBeforeDial = async (what: string, run: () => Promise<unknown>) => {
  await assert.rejects(run, (e: unknown) => (e as { code?: string }).code === "failed-precondition", what); checks++;
};
await refusedBeforeDial("a grant for another space", () => serve(grant({ space: "neighbour" })));
await refusedBeforeDial("a grant for another endpoint", () => serve(grant({ endpoint: "manager" })));
await refusedBeforeDial("a predecessor's grant (another incarnation)", () => serve(grant({ instanceId: mintLifecycleUid() })));
await refusedBeforeDial("a neighbour agent's grant", () => serve(grant(), { ...SELF, lifecycleUid: mintLifecycleUid() }));
assert.throws(() => serveToolResults(null as never, SPACE, grant({ instanceId: mintLifecycleUid() }), journal, SELF, () => undefined),
  (e: unknown) => (e as { code?: string }).code === "failed-precondition", "serving under any instance id but the lifecycle UID is refused"); checks++;

// ---- registered anchors ride the material as a path; applied consents are rechecked -------------
{
  const env = materialEnv({ creds: "/dev/null", toolResults: { creds: SERVE_CREDS, grant: grant(), consentAnchors: "/etc/cotal/consent-anchors.json" } });
  assert.equal(readLaunchMaterial(env[LAUNCH_MATERIAL_ENV]!).toolResults?.consentAnchors, "/etc/cotal/consent-anchors.json", "only the anchor file's path rides the material"); checks++;
  const j = new ToolResultJournal();
  j.applyConsent({ id: "c".repeat(22), holder: { id: "u_x.web" }, exp: Number.MAX_SAFE_INTEGER, issuer: { keyId: "host-1" }, iat: 0 });
  assert.equal(j.sharing, "consented"); checks++;
  assert.equal(await j.recheckSigners(async () => true), 0, "a current signer keeps its consent"); checks++;
  assert.equal(await j.recheckSigners(async () => { throw new Error("refresh failed"); }), 1, "a failed recheck withdraws the consent"); checks++;
  assert.equal(j.sharing, "off", "with no consent left capture stops and held results are discarded"); checks++;
}

console.log(`tool-result-serve smoke: ${checks} checks passed`);
