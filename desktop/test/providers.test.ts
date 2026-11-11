import { test } from "node:test";
import assert from "node:assert/strict";
import { activeComputerAccount, catalogRefreshNotice } from "../src/model.ts";
const own = "https://cloud.cotal.ai/api/auth", other = "https://hack.cotal.ai/api/auth";
test("refresh scopes provider failures and retains old daemon behavior", () => {
  assert.match(catalogRefreshNotice({ refresh: "partial", failedProviders: [other] }, own), /hack\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [own] }, own), /cloud\.cotal\.ai/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial" }, own), /Some space catalogs/);
  assert.throws(() => catalogRefreshNotice({ refresh: "partial", failedProviders: [], collisions: 1 }, own), /names conflict/);
  assert.throws(() => catalogRefreshNotice({ refresh: "complete", failedProviders: [], unreadable: 1 }, own), /could not be read/);
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
