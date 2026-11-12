import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import { grantManagedActor, ledgerAclResolver, newActorToken } from "../src/ledger.js";
import { calloutPermissions } from "../src/permissions.js";
import type { ValidatedUserToken } from "../src/token.js";
const dir = mkdtempSync(join(tmpdir(), "payload-policy-"));
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
