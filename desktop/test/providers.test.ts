import { test } from "node:test";
import assert from "node:assert/strict";
import { activeComputerAccount, catalogRefreshNotice } from "../src/model.ts";
const own = "https://cloud.cotal.ai/api/auth", other = "https://hack.cotal.ai/api/auth";
test("refresh scopes provider failures and retains old daemon behavior", () => {
  assert.match(catalogRefreshNotice({ refresh: "partial", failedProviders: [other] }, own).message, /hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [own] }, own), /cloud\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial" }, own), /Some space catalogs/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [], collisions: 1 }, own), /without their details.*cotal sync/);
  assert.throws(() => catalogRefreshNotice({ refresh: "complete", failedProviders: [], unreadable: 1 }, own), /could not be read/);
});
test("collision notices name the retained registration and the remedy for its origin", () => {
  const collisionDetails = [
    { space: "manual-team", origin: "manual", idp: own },
    { space: "-local-team", origin: "up", idp: own },
    { space: "catalog-team", origin: "catalog", idp: other },
  ];
  const result = { refresh: "partial", failedProviders: [other], collisions: 3, collisionDetails };
  const { message: notice, skipped } = catalogRefreshNotice(result, own);
  assert.deepEqual([...skipped], ["manual-team", "-local-team"]);
  assert.match(notice, /Leave them as they are to keep them/);
  assert.match(notice, /"manual-team" was registered by hand.*cotal space forget manual-team/);
  assert.match(notice, /"-local-team" was started on this computer.*cotal down.*cotal space forget -- -local-team/);
  assert.match(notice, /"catalog-team" is from another account's catalog.*sign out of that account/);
  assert.doesNotMatch(notice, /space forget catalog-team/);
  assert.match(notice, /cotal sync.*hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ ...result, failedProviders: [own] }, own), /cloud\.cotal\.ai/);
});
test("a collision with an unavailable catalog row cannot recommend removing a retained registration", () => {
  const { message } = catalogRefreshNotice({ refresh: "partial", failedProviders: [], collisions: 1,
    collisionDetails: [{ space: "held", origin: "manual", idp: own, unavailable: "maintenance window" }],
  }, own);
  assert.match(message, /"held" was kept \(registered by hand\).*maintenance window.*Keep the existing registration/);
  assert.doesNotMatch(message, /space forget|sign out|cotal sync/);
});
test("account follows active provider or the only supported account, not the last saved account", () => {
  const good = { idpUrl: own, mode: "account", hostSupport: "supported", spaces: [] };
  const dead = { idpUrl: other, mode: "account", hostSupport: "unknown", spaces: [] };
  const status = { ...dead, accounts: [good, dead] };
  for (const typed of ["https://cloud.cotal.ai", "https://cloud.cotal.ai/", `${own}/`]) {
    assert.equal(activeComputerAccount(status, typed), good);
    assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [own] }, typed), /cloud\.cotal\.ai/);
  }
  assert.equal(activeComputerAccount(status), good);
  assert.equal(activeComputerAccount(status, own), good);
  assert.equal(activeComputerAccount(status, other), dead);
  assert.equal(activeComputerAccount({ ...status, accounts: [good, { ...dead, hostSupport: "supported" }] }), undefined);
});
