import { test } from "node:test";
import assert from "node:assert/strict";
import { activeComputerAccount, catalogRefreshView } from "../src/model.ts";
const own = "https://cloud.cotal.ai/api/auth", other = "https://hack.cotal.ai/api/auth";
test("refresh scopes provider failures and retains old daemon behavior", () => {
  assert.match(catalogRefreshView({ refresh: "partial", failedProviders: [other] }, own).message, /hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshView({ refresh: "partial", failedProviders: [own] }, own), /cloud\.cotal\.ai/);
  assert.throws(() => catalogRefreshView({ refresh: "partial" }, own), /Some space catalogs/);
  assert.throws(() => catalogRefreshView({ refresh: "partial", failedProviders: [], collisions: 1 }, own), /did not identify the space name conflicts/);
  assert.throws(() => catalogRefreshView({ refresh: "complete", failedProviders: [], unreadable: 1 }, own), /could not be read/);
});
test("catalog collisions report every origin and preserve another provider's failure notice", () => {
  const collisionDetails = [
    { space: "-manual", origin: "manual", idp: own },
    { space: "local", origin: "up", idp: own },
    { space: "remote", origin: "catalog", idp: own },
    { space: "elsewhere", origin: "manual", idp: "https://another.example/api/auth" },
  ];
  const view = catalogRefreshView({ refresh: "partial", failedProviders: [other], collisions: 4, collisionDetails }, own);
  assert.deepEqual([...view.blockedSpaces], ["-manual", "local", "remote"]);
  assert.match(view.message, /hack\.cotal\.ai/);
  assert.match(view.message, /-manual \(registered by hand\).*cotal space forget -- -manual/);
  assert.match(view.message, /local \(started on this computer\).*stop the local space.*cotal space forget local/);
  assert.match(view.message, /remote \(from another account’s catalog\).*sign out of the account/);
  assert.doesNotMatch(view.message, /cotal space forget remote/);
  assert.match(view.message, /elsewhere \(registered by hand\)/);
  assert.throws(() => catalogRefreshView({ collisions: 1, collisionDetails: [{ space: "unsafe\n", idp: own, origin: "manual" }] }), /did not identify/);
});
test("an unavailable catalog collision never suggests releasing the existing name", () => {
  const collisionDetails = [
    { space: "held", origin: "manual", idp: own, unavailable: true },
    { space: "foreign", origin: "catalog", idp: own, unavailable: true },
  ];
  const { message } = catalogRefreshView({ refresh: "partial", failedProviders: [], collisions: 2, collisionDetails }, own);
  assert.match(message, /held \(registered by hand\): The catalog space is unavailable/);
  assert.match(message, /foreign \(from another account’s catalog\): The catalog space is unavailable/);
  assert.doesNotMatch(message, /forget|sign out/);
});
test("account follows active provider or the only supported account, not the last saved account", () => {
  const good = { idpUrl: own, mode: "account", hostSupport: "supported", spaces: [] };
  const dead = { idpUrl: other, mode: "account", hostSupport: "unknown", spaces: [] };
  const status = { ...dead, accounts: [good, dead] };
  for (const typed of ["https://cloud.cotal.ai", "https://cloud.cotal.ai/", `${own}/`]) {
    assert.equal(activeComputerAccount(status, typed), good);
    assert.throws(() => catalogRefreshView({ refresh: "partial", failedProviders: [own] }, typed), /cloud\.cotal\.ai/);
  }
  assert.equal(activeComputerAccount(status), good);
  assert.equal(activeComputerAccount(status, own), good);
  assert.equal(activeComputerAccount(status, other), dead);
  assert.equal(activeComputerAccount({ ...status, accounts: [good, { ...dead, hostSupport: "supported" }] }), undefined);
});
