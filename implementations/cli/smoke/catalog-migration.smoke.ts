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
  // Mixed ownership (6 old-owned + 1 already imported under new account during an earlier sign-in before moving):
  rmSync(home, { recursive: true, force: true });
  const oldSlugs = ["space-1", "space-2", "space-3", "space-4", "space-5", "space-6"];
  for (const slug of oldSlugs) importAccountComputerSpace(old, row(old, slug, `stable-${slug}`));
  importAccountComputerSpace(next, row(next, "member-7", "stable-member-7"));
  const existingNew = readMesh("member-7")!;
  const existingNewCreds = readFileSync(existingNew.userAuth!.sentinelCredsPath!, "utf8");
  const mixedSnapshot: SpaceCatalogSnapshot = {
    v: 1,
    account: next,
    spaces: [
      ...oldSlugs.map(slug => row(next, slug, `stable-${slug}`)),
      row(next, "member-7", "stable-member-7"),
    ],
  };
  // Real losses or unaccounted rows still refuse under mixed ownership:
  assert.throws(() => prepareCatalogMigration(old, next, {
    ...mixedSnapshot,
    spaces: mixedSnapshot.spaces.filter(s => s.slug !== "space-6"),
  }), /preserve the owned space ID set/);
  assert.throws(() => prepareCatalogMigration(old, next, {
    ...mixedSnapshot,
    spaces: [...mixedSnapshot.spaces.slice(0, 6), row(next, "member-renamed", "stable-member-7")],
  }), /preserve owned space IDs and slugs/);
  assert.throws(() => prepareCatalogMigration(old, next, {
    ...mixedSnapshot,
    spaces: [...mixedSnapshot.spaces, row(next, "unaccounted-8", "stable-8")],
  }), /preserve owned space IDs and slugs/);
  const commitMixed = prepareCatalogMigration(old, next, mixedSnapshot);
  commitMixed();
  for (const slug of oldSlugs) {
    assert.equal(readMesh(slug)!.catalogOwner, "new", `${slug} moved to new account`);
  }
  assert.deepEqual(readMesh("member-7"), existingNew, "already new-owned space stays untouched");
  assert.equal(readFileSync(existingNew.userAuth!.sentinelCredsPath!, "utf8"), existingNewCreds);
  console.log("catalog migration representative API smoke passed");
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
