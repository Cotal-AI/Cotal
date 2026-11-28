import { test } from "node:test";
import assert from "node:assert/strict";
import { activeComputerAccount, catalogRefreshNotice, parseEndorsedMigration, parseSpaceCollisions } from "../src/model.ts";
import { existingRegistrationCopy } from "../src/space-conflicts.ts";

const own = "https://cotal.cloud/api/auth", legacy = "https://cloud.cotal.ai/api/auth", other = "https://hack.cotal.ai/api/auth";
test("refresh scopes provider failures and surfaces non-blocking space-name conflict details without CLI dead ends", () => {
  assert.match(catalogRefreshNotice({ refresh: "partial", failedProviders: [other] }, own), /hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [own] }, own), /cotal\.cloud/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial" }, own), /Some space catalogs/);
  const fallback = catalogRefreshNotice({ refresh: "partial", failedProviders: [], collisions: 1 }, own);
  assert.match(fallback, /kept those registrations.*Space conflicts/);
  assert.doesNotMatch(fallback, /cotal sync|cotal space/);
  const detailed = catalogRefreshNotice({
    refresh: "partial",
    failedProviders: [],
    collisions: 1,
    collisionDetails: [{ space: "acme-team", catalogLabel: "Acme team", catalogIdp: own, existingOrigin: "up" }],
  }, own);
  assert.match(detailed, /Space "acme-team" conflicts.*kept that registration/);
  assert.doesNotMatch(detailed, /cotal sync|cotal space/);
  const endorsed = catalogRefreshNotice({
    refresh: "partial",
    failedProviders: [],
    collisions: 2,
    collisionDetails: [
      { space: "personal-home", catalogLabel: "Personal", catalogIdp: own, existingOrigin: "catalog", existingIdp: legacy },
      { space: "cotal-team", catalogLabel: "Cotal team", catalogIdp: own, existingOrigin: "catalog", existingIdp: legacy },
    ],
    migration: { fromIdp: legacy, toIdp: own, spaces: ["personal-home", "cotal-team"] },
  }, own);
  assert.match(endorsed, /personal-home, cotal-team.*cloud\.cotal\.ai.*Move account.*cotal\.cloud/);
  assert.doesNotMatch(endorsed, /cotal sync|cotal space|cotal login/);
  assert.match(catalogRefreshNotice({ refresh: "partial", failedProviders: [other], collisions: 1 }, own), /names conflict.*hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [own], collisions: 1 }, own), /cotal\.cloud/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [], collisions: 1, unreadable: 1 }, own), /could not be read/);
  assert.throws(() => catalogRefreshNotice({ refresh: "complete", failedProviders: [], unreadable: 1 }, own), /could not be read/);
});
test("space collision parsers and plain-word origin descriptions handle catalog, local up, and manual registrations", () => {
  const collisions = parseSpaceCollisions({
    collisionDetails: [
      { space: "personal-home", catalogLabel: "Personal", catalogIdp: own, existingOrigin: "catalog", existingIdp: legacy },
      { space: "local-dev", catalogLabel: "Local dev", catalogIdp: own, existingOrigin: "up" },
      { space: "saved-manual", catalogLabel: "Saved manual", catalogIdp: own, existingOrigin: "manual", existingIdp: other },
      { space: "bad-origin", catalogLabel: "Bad", catalogIdp: own, existingOrigin: "unknown" },
    ],
  });
  assert.equal(collisions.length, 3);
  assert.equal(existingRegistrationCopy(collisions[0]), "Currently registered under cloud.cotal.ai.");
  assert.equal(existingRegistrationCopy(collisions[1]), "Currently registered from a local space on this computer.");
  assert.equal(existingRegistrationCopy(collisions[2]), "Currently saved manually (hack.cotal.ai) on this computer.");
  assert.deepEqual(parseEndorsedMigration({ migration: { fromIdp: legacy, toIdp: own, spaces: ["personal-home"] } }), {
    fromIdp: legacy,
    toIdp: own,
    spaces: ["personal-home"],
  });
  assert.equal(parseEndorsedMigration({ migration: { fromIdp: legacy, toIdp: own, spaces: [] } }), undefined);
});
test("account follows active provider or the only supported account, not the last saved account", () => {
  const good = { idpUrl: legacy, mode: "account", hostSupport: "supported", spaces: [] };
  const dead = { idpUrl: other, mode: "account", hostSupport: "unknown", spaces: [] };
  const status = { ...dead, accounts: [good, dead] };
  for (const typed of ["https://cloud.cotal.ai", "https://cloud.cotal.ai/", `${legacy}/`]) {
    assert.equal(activeComputerAccount(status, typed), good);
    assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [legacy] }, typed), /cloud\.cotal\.ai/);
  }
  assert.equal(activeComputerAccount(status), good);
  assert.equal(activeComputerAccount(status, legacy), good);
  assert.equal(activeComputerAccount(status, other), dead);
  assert.equal(activeComputerAccount({ ...status, accounts: [good, { ...dead, hostSupport: "supported" }] }), undefined);
});
