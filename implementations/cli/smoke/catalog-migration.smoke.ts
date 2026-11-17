/** Representative registry API coverage only. Public login acceptance belongs to the caller. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrent, readMesh, recordMeshes, setCurrent } from "@cotal-ai/workspace";
import { importAccountComputerSpace, prepareCatalogMigration, type SpaceCatalogSnapshot } from "../src/commands/sync.js";

const home = mkdtempSync(join(realpathSync(tmpdir()), "cotal-catalog-migration-"));
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;
const old = { idpUrl: "https://old.example/auth", issuer: "https://issuer.example", sub: "person", ownerKey: "old" };
const next = { ...old, idpUrl: "https://new.example/auth", ownerKey: "new" };
const row = (account = old, slug = "alpha", id = "stable-alpha") => ({ id, slug, name: slug, kind: "team", role: "member", registration: {
  space: slug, server: "nats://127.0.0.1:1", tlsRequired: false, sentinelCreds: `${account.ownerKey}-sentinel`,
  userAuth: { provider: "cotal", idp: { url: account.idpUrl, issuer: account.issuer, audience: "cotal-cli" }, endpoints: { url: `${new URL(account.idpUrl).origin}/exchange` } },
} });
const snapshot = (): SpaceCatalogSnapshot => ({ v: 1, account: next, spaces: [row(next)] });
const files = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? files(join(dir, entry.name)) : readFileSync(join(dir, entry.name), "utf8")]);
try {
  importAccountComputerSpace(old, row());
  setCurrent("alpha");
  const original = readMesh("alpha")!;
  const sentinel = original.userAuth!.sentinelCredsPath!;
  const session = join(home, "old-session.json"), authority = join(home, "native-authority.json");
  writeFileSync(session, "old-session-canary");
  writeFileSync(authority, "old-authority-canary");
  const before = files(home);
  const commit = prepareCatalogMigration(old, next, snapshot());
  assert.deepEqual(files(home), before, "preparation performs no writes");
  for (const bad of [
    { ...snapshot(), spaces: [] },
    { ...snapshot(), spaces: [row(next, "renamed")] },
    { ...snapshot(), spaces: [row(next, "alpha", "different")] },
    { ...snapshot(), spaces: [row(next), row(next)] },
    { ...snapshot(), spaces: [row(next), row(next, "beta")] },
    { ...snapshot(), spaces: [{ id: "stable-alpha", slug: "alpha", name: "alpha", kind: "team", role: "member", unavailable: "offline" }] },
  ]) assert.throws(() => prepareCatalogMigration(old, next, bad));
  assert.throws(() => prepareCatalogMigration(old, { ...next, sub: "other" }, snapshot()), /issuer and subject/);
  const wrongAudience = snapshot();
  (wrongAudience.spaces[0] as ReturnType<typeof row>).registration.userAuth.idp.audience = "other";
  assert.throws(() => prepareCatalogMigration(old, next, wrongAudience), /audience/);
  assert.deepEqual(files(home), before, "refusals perform no writes");
  recordMeshes([{ ...original, catalogRole: "admin" }]);
  const changed = files(home);
  assert.throws(commit, /changed after preparation/);
  assert.deepEqual(files(home), changed, "stale commit performs no writes");
  recordMeshes([original]);
  const detached = snapshot();
  const migrate = prepareCatalogMigration(old, next, detached);
  (detached.spaces[0] as ReturnType<typeof row>).registration.sentinelCreds = "caller-mutation";
  migrate();
  const migrated = readMesh("alpha")!;
  assert.equal(migrated.catalogOwner, "new");
  assert.equal(migrated.catalogId, original.catalogId);
  assert.equal(migrated.root, original.root);
  assert.equal(migrated.catalogRoot, original.catalogRoot);
  assert.equal(migrated.userAuth!.sentinelCredsPath, sentinel);
  assert.equal(readFileSync(sentinel, "utf8"), "new-sentinel");
  assert.equal(getCurrent(), "alpha");
  assert.equal(readFileSync(session, "utf8"), "old-session-canary");
  assert.equal(readFileSync(authority, "utf8"), "old-authority-canary");
  assert.throws(() => importAccountComputerSpace(old, row()), /different local registration/);
  assert.equal(readMesh("alpha")!.catalogOwner, "new", "legacy catalog replay stays a collision");
  recordMeshes([{ ...original, origin: "manual" }]);
  assert.throws(() => prepareCatalogMigration(old, next, snapshot()), /undamaged registry/);
  console.log("catalog migration representative API smoke passed");
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
