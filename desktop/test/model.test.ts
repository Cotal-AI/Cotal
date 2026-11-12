import { test } from "node:test";
import assert from "node:assert/strict";
import { initialSpace, approvalUrl, connectionView, refusalView, requireResult, onboardingLink, launchReady, machinesUrl, keptCredentialsNotice } from "../src/model.ts";

test("account targeting prefers the link, personal space, only space, then asks", () => {
  const personal = { space: "mine", catalogId: "sp_mine", label: "Mine", kind: "personal" };
  const team = { space: "team", catalogId: "sp_team", label: "Team", kind: "team" };
  assert.equal(initialSpace([personal, team], "sp_team"), "team");
  assert.equal(initialSpace([team, personal]), "mine");
  assert.equal(initialSpace([team]), "team");
  assert.equal(initialSpace([team, { ...team, space: "other" }]), undefined);
  assert.equal(initialSpace([]), undefined);
});

test("only verified service connection is presented as connected", () => {
  for (const state of ["ready", "connecting", "approval-pending", "disconnected", "refused", "unknown"]) assert.equal(connectionView(state).connected, false);
  assert.equal(connectionView("connected").connected, false);
  assert.equal(connectionView("launch-ready").connected, true);
});

test("approval guidance refers to this computer", () => {
  assert.equal(connectionView("approval-pending").description, "The space owner must approve this computer. No connection is claimed yet.");
});

test("launch readiness requires an answering registered Manager with an available application", () => {
  for (const manager of [undefined, {}, { state: "answering" }, { state: "restarting", instanceId: "m", connectors: [{ state: "available" }] }, { state: "answering", instanceId: "m", connectors: [{ state: "unavailable" }] }]) assert.equal(launchReady(manager), false);
  assert.equal(launchReady({ state: "answering", instanceId: "m", connectors: [{ state: "available" }] }), true);
  assert.equal(connectionView("launch-ready").title, "This computer is connected");
  assert.equal(machinesUrl("https://cloud.cotal.ai/api/auth", "sp_636f74616c5f636c6f7564", "manager&exact"), "https://cloud.cotal.ai/machines?space=sp_636f74616c5f636c6f7564&machine=manager%26exact");
});
test("browser links reject executable schemes and embedded credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com", "http://example.com", "http://127.0.0.1.example.com"]) assert.throws(() => approvalUrl(url));
  assert.equal(approvalUrl("https://example.com/approve?user_code=ABCD"), "https://example.com/approve?user_code=ABCD");
  assert.equal(approvalUrl("http://127.0.0.1:8080/approve"), "http://127.0.0.1:8080/approve");
});
test("a prompt, malformed version or refusal is never a successful operation", () => {
  assert.throws(() => requireResult({ v: 1, event: "login-prompt", ok: true }));
  assert.throws(() => requireResult({ v: 1, event: "result", ok: false, error: { code: "DENIED", message: "Denied" } }), /Denied/);
  assert.throws(() => requireResult({ v: 1, event: "result", ok: true }));
  assert.deepEqual(requireResult({ v: 1, event: "result", ok: true, result: { state: "ready" } }), { state: "ready" });
});

test("dashboard links prefill only public coordinates and reject secrets or duplicate keys", () => {
  assert.deepEqual(onboardingLink("cotal://connect?idp=https%3A%2F%2Fexample.com%2Fauth&space=team"), { idp: "https://example.com/auth", space: "team" });
  for (const value of ["cotal://connect?idp=https://example.com/auth&token=secret", "cotal://connect?idp=https://example.com&idp=https://other.example", "cotal://exec?idp=https://example.com", "cotal://connect?idp=file:///tmp/auth", "cotal://connect?idp=https://example.com&space=bad%20space"]) assert.throws(() => onboardingLink(value));
});

test("expired credentials and pending approval refusals map to their recovery actions", () => {
  assert.deepEqual(refusalView("CREDENTIAL_EXPIRED"), {
    title: "Sign in again",
    description: "Your saved sign-in has expired. Approve this computer in your browser to reconnect.",
    action: "login",
    label: "Sign in again",
  });
  assert.deepEqual(refusalView("APPROVAL_PENDING"), {
    title: "Waiting for owner approval",
    description: "The space owner needs to approve this computer. Ask them to review the request, then check its status.",
    action: "refresh",
    label: "Check approval",
  });
});

test("kept credential notice names each well-formed file and is empty otherwise", () => {
  assert.equal(keptCredentialsNotice({ outcome: "signed-in" }), "");
  assert.equal(keptCredentialsNotice({ outcome: "signed-in", credentialsKept: [] }), "");
  assert.equal(keptCredentialsNotice({ outcome: "signed-in", credentialsKept: [null, { space: "a" }, "x"] }), "");
  const two = keptCredentialsNotice({ credentialsKept: [{ space: "a", path: "/p/a", reason: "EACCES" }, { space: "b", path: "/p/b", reason: "it is a symbolic link" }, { path: 1 }] });
  assert.match(two, /^Signed in, but 2 credential files of the previous account's spaces could not be deleted: \/p\/a \(a: EACCES\), \/p\/b \(b: it is a symbolic link\)\. Delete each file named\./);
  assert.match(keptCredentialsNotice({ credentialsKept: [{ space: "a", path: "/p/a", reason: "EACCES" }] }), /^Signed in, but a credential file /);
});
