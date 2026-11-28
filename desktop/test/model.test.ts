import { test } from "node:test";
import assert from "node:assert/strict";
import { COTAL_CLOUD_IDP, isCotalCloudIdp, initialSpace, approvalUrl, connectionView, refusalView, requireResult, onboardingLink, launchReady, machinesUrl, keptCredentialsNotice, shownSpaceLabel, shownSpaceKind, shownAccountLabel, DaemonRefusal, sameProvider, disconnectSpacesForProvider, isSignedOutComputerAccount, activeComputerAccount, logoutConfirmationCopy, logoutFailureOutcome } from "../src/model.ts";

test("a blank space label is the space id and a label with a character stays", () => {
  assert.equal(shownSpaceLabel(" ", "team"), "team");
  assert.equal(shownSpaceLabel("", "team"), "team");
  assert.equal(shownSpaceLabel("\n", "team"), "team");
  assert.equal(shownSpaceLabel(undefined, "team"), "team");
  assert.equal(shownSpaceLabel(" ada", "team"), " ada");
  assert.equal(shownSpaceLabel("My team", "team"), "My team");
  assert.equal(shownSpaceKind(" "), "Space");
  assert.equal(shownSpaceKind(""), "Space");
  assert.equal(shownSpaceKind("\n"), "Space");
  assert.equal(shownSpaceKind(undefined), "Space");
  assert.equal(shownSpaceKind(" ada"), "Ada");
  assert.equal(shownSpaceKind("team"), "Team");
});

test("a blank account label is the subject and a label with a character stays", () => {
  assert.equal(shownAccountLabel(" ", "user-1"), "user-1");
  assert.equal(shownAccountLabel("", "user-1"), "user-1");
  assert.equal(shownAccountLabel("\n", "user-1"), "user-1");
  assert.equal(shownAccountLabel(undefined, "user-1"), "user-1");
  assert.equal(shownAccountLabel(" ", " "), undefined);
  assert.equal(shownAccountLabel(" ada", "user-1"), " ada");
  assert.equal(shownAccountLabel("Ada", "user-1"), "Ada");
});

test("Cloud identity recognizes only the canonical and legacy auth URLs", () => {
  assert.equal(isCotalCloudIdp(COTAL_CLOUD_IDP), true);
  assert.equal(isCotalCloudIdp("https://cloud.cotal.ai/api/auth"), true);
  for (const provider of [undefined, "https://cotal.cloud/other", "https://cloud.cotal.ai/other", "http://cotal.cloud/api/auth", "https://cotal.cloud.evil.test/api/auth", "https://example.com/api/auth"]) {
    assert.equal(isCotalCloudIdp(provider), false);
  }
});

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
  // A Manager that lost its connection still answers its daemon, but nothing can launch through it.
  assert.equal(launchReady({ state: "answering", instanceId: "m", connectors: [{ state: "available" }], connection: { state: "offline", reason: "this computer cannot look up cotal.cloud (ENOTFOUND)" } }), false);
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

test("onboarding links never require custom-scheme URL support", () => {
  const NativeURL = globalThis.URL;
  globalThis.URL = class extends NativeURL {
    constructor(value: string | URL, base?: string | URL) {
      if (/^cotal:/i.test(String(value))) throw new Error("Custom-scheme URL parsing unavailable");
      super(value, base);
    }
  };
  try {
    for (const path of ["", "/"]) {
      assert.deepEqual(onboardingLink(`cotal://connect${path}?idp=https%3A%2F%2Fexample.com%2Fauth&space=sp_team`), { idp: "https://example.com/auth", space: "sp_team" });
    }
    assert.deepEqual(onboardingLink("COTAL://connect?idp=http%3A%2F%2F127.0.0.1%3A8080%2Fauth"), { idp: "http://127.0.0.1:8080/auth" });
  } finally { globalThis.URL = NativeURL; }
});

test("onboarding boundaries survive special-scheme normalization", () => {
  const query = "?idp=https%3A%2F%2Fexample.com%2Fauth";
  for (const target of ["CONNECT", "con%6Eect", "", "/connect", "connect:443", "connect:80", "connect:0", "connect:", "user@connect", "@connect", "user:pass@connect", "connect/path", "connect/..", "connect/%2e", "connect/a/..", "connect//", "connect\\", "connect\\..", "con\tnect", "connect."]) {
    assert.throws(() => onboardingLink(`cotal://${target}${query}`), Error, target);
  }
  for (const value of [
    `https://connect${query}`, `cotal:connect${query}`, `cotal:/connect${query}`,
    `cotal://connect${query}#fragment`, `cotal://connect${query}#`,
    `cotal://connect${query}&token=secret`, `cotal://connect${query}&idp=https://other.example`,
    `cotal://connect${query}&space=a&space=b`, `cotal://connect${query}&space=`,
    `cotal://connect${query}&space=bad%20space`, `cotal://connect${query}&space=${"x".repeat(65)}`,
    "cotal://connect", "cotal://connect?idp=javascript:alert(1)",
    "cotal://connect?idp=https%3A%2F%2Fexample.com%2Fauth%3Fx%3D1",
    "cotal://connect?idp=https%3A%2F%2Fexample.com%2Fauth%23fragment",
  ]) assert.throws(() => onboardingLink(value), Error, value);
});

test("the version mismatch says what happened, what the button does and what it costs", () => {
  assert.deepEqual(refusalView("VERSION_MISMATCH"), {
    title: "Cotal was updated",
    description: "Restart the background service to finish the update. If agents are running, the restart waits until they finish, then happens by itself.",
    action: "connect",
    label: "Restart background service",
  });
});

test("expired credentials and pending approval refusals map to their recovery actions", () => {
  assert.deepEqual(refusalView("CREDENTIAL_EXPIRED"), {
    title: "Sign in again",
    description: "Your saved sign-in has expired. Approve this computer in your browser to reconnect.",
    action: "login",
    label: "Sign in again",
  });
  assert.deepEqual(refusalView("NOT_RUNNING"), {
    title: "The background service is not running",
    description: "Start it again to continue.",
    action: "install",
    label: "Start service",
  });
  assert.deepEqual(refusalView("NOT_ANSWERING"), {
    title: "The background service has not started",
    description: "Cotal asked the background service on this computer to start, and it has not answered. Details shows the reason it gave, if it gave one.",
    action: "refresh",
    label: "Check status",
  });
  assert.deepEqual(refusalView("UNREACHABLE"), {
    title: "We cannot reach your connection",
    description: "Cotal reconnects by itself when the space answers again. Details shows the reason.",
    action: "refresh",
    label: "Try again",
  });
  assert.deepEqual(refusalView("OFFLINE"), {
    title: "No internet connection",
    description: "Cotal reconnects by itself when this computer is back online.",
    action: "refresh",
    label: "Check again",
  });
  assert.deepEqual(refusalView("SPACE_UNREACHABLE"), {
    title: "Can't reach your space",
    description: "Cotal reconnects by itself when the space answers again. Details shows the reason.",
    action: "refresh",
    label: "Check again",
  });
  assert.deepEqual(refusalView("APPROVAL_PENDING"), {
    title: "Waiting for owner approval",
    description: "The space owner needs to approve this computer. Ask them to review the request, then check its status.",
    action: "refresh",
    label: "Check approval",
  });
});

test("another installation's service offers no action and keeps a command out of the window", () => {
  assert.deepEqual(refusalView("CONFLICT"), {
    title: "Another Cotal installation runs the background service",
    description: "This copy cannot take it over. Nothing was changed.",
    action: "none",
    label: "",
  });
  const refused = () => { requireResult({ v: 1, event: "result", ok: false, error: { code: "CONFLICT", message: "the background service was set up by another Cotal installation", remedy: "run setup from /usr/local/lib/node_modules/cotal-ai/bin/cotal.js" } }); };
  assert.throws(refused, (error: { remedy?: string; message: string }) => error.remedy === undefined && !/\/usr\/local|`/.test(error.message));
});

test("kept credential notice names each well-formed file and is empty otherwise", () => {
  assert.equal(keptCredentialsNotice({ outcome: "signed-in" }), "");
  assert.equal(keptCredentialsNotice({ outcome: "signed-in", credentialsKept: [] }), "");
  assert.equal(keptCredentialsNotice({ outcome: "signed-in", credentialsKept: [null, { space: "a" }, "x"] }), "");
  const two = keptCredentialsNotice({ credentialsKept: [{ space: "a", path: "/p/a", reason: "EACCES" }, { space: "b", path: "/p/b", reason: "it is a symbolic link" }, { path: 1 }] });
  assert.match(two, /^Signed in, but 2 credential files of the previous account's spaces could not be deleted: \/p\/a \(a: EACCES\), \/p\/b \(b: it is a symbolic link\)\. Delete each file named\./);
  assert.match(keptCredentialsNotice({ credentialsKept: [{ space: "a", path: "/p/a", reason: "EACCES" }] }), /^Signed in, but a credential file /);
});

test("computer sign-out confirmation, signed-out account detection, and failed-disconnect outcome copy", () => {
  assert.equal(sameProvider("https://cotal.cloud", "https://cotal.cloud/api/auth/"), true);
  assert.equal(sameProvider("https://cotal.cloud/api/auth", "https://example.com/api/auth"), false);
  const spaces = disconnectSpacesForProvider(
    "https://cotal.cloud/api/auth",
    {
      idpUrl: "https://cotal.cloud",
      mode: "account",
      hostSupport: "supported",
      spaces: [
        { space: "acme-team", desired: true, observed: "connected" },
        { space: "off", desired: false, observed: "disconnected" },
        { space: "drifted", desired: false, observed: "connected" },
      ],
    },
    new Map([["direct-space", "launch-ready"], ["other-idp-space", "launch-ready"]]),
    new Map([["direct-space", "https://cotal.cloud/api/auth"], ["other-idp-space", "https://example.com/api/auth"]]),
  );
  assert.equal(spaces.length, 3);
  assert.deepEqual(spaces, ["acme-team", "drifted", "direct-space"]);
  assert.equal(isSignedOutComputerAccount(undefined), false);
  assert.equal(isSignedOutComputerAccount({ mode: "signed-out", hostSupport: "unknown", spaces: [] }), false);
  const signedOut = { idpUrl: "https://cotal.cloud/api/auth", mode: "signed-out", hostSupport: "unknown", spaces: [], accounts: [] };
  assert.equal(isSignedOutComputerAccount(signedOut), true);
  assert.equal(activeComputerAccount(signedOut), signedOut);
  assert.equal(activeComputerAccount(signedOut, "https://cotal.cloud/api/auth"), signedOut);
  assert.equal(logoutConfirmationCopy([]), "Signing out disconnects this computer from your spaces and ends your sign-in here. Your spaces come back automatically when you sign in again.");
  assert.equal(logoutConfirmationCopy(["writer-1 (Codex)"]), "Signing out stops 1 running agent (writer-1 (Codex)) and disconnects this computer from your spaces. Your spaces come back automatically when you sign in again.");
  assert.equal(logoutConfirmationCopy(["writer-1 (Codex)", "reviewer (Claude Code)"]), "Signing out stops 2 running agents (writer-1 (Codex) and reviewer (Claude Code)) and disconnects this computer from your spaces. Your spaces come back automatically when you sign in again.");
  const refusal = new DaemonRefusal(
    "MANAGER_UNAVAILABLE",
    "disconnecting research did not finish. Next: run `cotal daemon service-disconnect --space research`",
    undefined,
    "run `cotal daemon service-disconnect --space research`",
    {
      failedSpace: "research",
      stillConnectedSpaces: ["research", "ops"],
      stoppedAgents: [{ space: "acme-team", name: "writer-1", application: "codex" }],
      rawReason: "the governing auth service refused endpoint deregistration; run `cotal endpoint deregister`",
    },
  );
  const out = logoutFailureOutcome(
    refusal,
    s => ({ research: "Research", ops: "Ops" }[s] ?? s),
    a => `${a.name} (${a.application})`,
  );
  assert.equal(out.summary, "You're still signed in. Cotal couldn't disconnect Research, so it stopped signing out.\nStill connected: Research, Ops.\nThese agents were stopped: writer-1 (codex).");
  assert.ok(!out.detail.includes("cotal "), "Details omits command lines");
});
