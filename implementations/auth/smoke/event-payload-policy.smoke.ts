import { parseAuthHostManifest, runAuthService } from "../src/service.js";
import type { ParsedArgs } from "@cotal-ai/core";
import type { AuthServiceRuntimeOptions } from "../src/service.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import { grantManagedActor, ledgerAclResolver, newActorToken } from "../src/ledger.js";
import { calloutPermissions } from "../src/permissions.js";
import type { ValidatedUserToken } from "../src/token.js";
const manifest = (eventPayloads: unknown) => JSON.stringify({ version: 2, spaces: [{ space: "payload", eventPayloads }] });
assert.equal(parseAuthHostManifest(manifest("withheld")).settings.get("payload")?.eventPayloads, "withheld");
for (const value of [false, true, "publish", null, {}])
  assert.throws(() => parseAuthHostManifest(manifest(value)), /eventPayloads must be/);
const dir = mkdtempSync(join(tmpdir(), "payload-policy-"));
for (const eventPayloadsWithheld of ["false", null, 0]) {
  let touched = false;
  const args = { get values(): ParsedArgs["values"] { touched = true; throw new Error("unexpected argument effect"); }, positionals: [], raw: [] } as ParsedArgs;
  await assert.rejects(() => runAuthService(args, undefined, { eventPayloadsWithheld } as unknown as AuthServiceRuntimeOptions), /eventPayloadsWithheld must be a boolean/);
  assert.equal(touched, false);
}
try {
  const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lifecycleUid = mintLifecycleUid();
  grantManagedActor(dir, { owner, actor: "seat", scope: [], allowSubscribe: [], allowPublish: [], eventPayloads: false,
    custody: { kind: "foreground" }, tokenHash: newActorToken().tokenHash, lifecycleUid });
  const token: ValidatedUserToken = { owner, space: "payload", scope: [], act: { owner, actor: "seat", scope: [], lifecycleUid }, ver: 1, exp: Math.floor(Date.now() / 1000) + 60 };
  for (let n = 0; n < 2; n++) {
    const acl = ledgerAclResolver(dir)(token);
    assert.equal(acl.eventPayloads, false);
    const permissions = calloutPermissions(ledgerAclResolver(dir))(token, `payloadprobe${n}`, `payloadreader${n}`) as { pub: { allow: string[] } };
    assert.equal(permissions.pub.allow.includes(`cotal.payload.evp.${owner}.seat`), false);
  }
  console.log("PASS durable ledger withholding reaches fresh callout mints");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
