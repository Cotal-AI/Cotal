import { test } from "node:test";
import assert from "node:assert/strict";
import { installedMessage, orderedApps, parseApps, refusalDetail, refusalMessage, rowView, signInUrl, suggestedApp, type AgentApp } from "../src/agent-apps-model.ts";
import { DaemonRefusal } from "../src/model.ts";

const app = (name: string, state: AgentApp["state"], extra: Partial<AgentApp> = {}): AgentApp => ({ name, title: name.toUpperCase(), maker: "Maker", state, install: { source: `${name}.example` }, ...extra });

test("rows say where each application stands and offer the one next step", () => {
  assert.deepEqual(rowView(app("claude", "signed-in", { version: "2.1.3" }), undefined, "darwin"), { tone: "ready", status: "Signed in · version 2.1.3" });
  assert.deepEqual(rowView(app("pi", "installed"), undefined, "linux"), { tone: "ready", status: "Installed" });
  assert.deepEqual(rowView(app("codex", "signed-out", { version: "0.1" }), undefined, "win32"), { tone: "warn", status: "Installed · version 0.1, not signed in", action: { kind: "sign-in", label: "Sign in", primary: true } });
  assert.deepEqual(rowView(app("jcode", "missing"), undefined, "linux"), { tone: "missing", status: "Not installed · installs from jcode.example", action: { kind: "install", label: "Install" } });
  // Before Install, a row says what it downloads and from where, and who declared the installer when it is not Cotal.
  assert.equal(rowView(app("hermes", "missing", { missing: ["uv"], install: { source: "astral.sh" } }), undefined, "linux").status, "Not installed · installs uv from astral.sh");
  assert.equal(rowView(app("claude", "missing", { missing: ["claude"], install: { source: "claude.ai" } }), undefined, "linux").status, "Not installed · installs from claude.ai");
  assert.equal(rowView(app("thing", "missing", { package: "cotal-connector-thing" }), undefined, "linux").status, "Not installed · installs from thing.example · package cotal-connector-thing");
  assert.deepEqual(rowView(app("pi", "missing", { install: { source: "pi.dev", needs: ["node", "npm"] } }), undefined, "linux"), { tone: "off", status: "Needs node and npm installed first" });
  // A declared harness with no installer for this system, and a connector that declares none.
  assert.deepEqual(rowView({ ...app("opencode", "missing"), install: undefined }, undefined, "win32"), { tone: "off", status: "No installer for Windows" });
  assert.deepEqual(rowView({ name: "custom", title: "custom", state: "missing" }, undefined, "linux"), { tone: "off", status: "Not installed" });
});

test("a running or failed action replaces the row's state", () => {
  const claude = app("claude", "missing", { install: { source: "claude.ai" } });
  assert.deepEqual(rowView(claude, { kind: "installing", line: "Installing native build latest…" }, "darwin"), { tone: "busy", status: "Installing from claude.ai…", line: "Installing native build latest…" });
  assert.deepEqual(rowView(claude, { kind: "signing-in" }, "darwin"), { tone: "busy", status: "Finish signing in in your browser" });
  assert.deepEqual(rowView(claude, { kind: "signing-in", url: "https://claude.ai/oauth/authorize?x=1" }, "darwin").action, { kind: "open-page", label: "Open sign-in page" });
  assert.deepEqual(rowView(claude, { kind: "failed", action: "install", message: "The installer stopped with exit code 1", detail: "curl: (56)" }, "darwin"),
    { tone: "failed", status: "Couldn’t install: The installer stopped with exit code 1", action: { kind: "install", label: "Try again" }, detail: "curl: (56)" });
  assert.equal(rowView(claude, { kind: "failed", action: "sign-in", message: "x" }, "darwin").status, "Couldn’t sign in: x");
});

test("Claude Code comes first and the no-app prompt suggests the first app it can install", () => {
  const apps = [app("hermes", "missing"), app("custom", "missing"), app("codex", "missing"), app("claude", "missing", { install: { source: "claude.ai", needs: ["curl"] } }), app("aaa", "missing")];
  assert.deepEqual(orderedApps(apps).map(item => item.name), ["claude", "codex", "hermes", "AAA", "CUSTOM"].map(name => name.toLowerCase()));
  // Claude Code's installer needs a missing tool here, so Codex is suggested; none installable means none.
  assert.equal(suggestedApp(apps)?.name, "codex");
  assert.equal(suggestedApp([app("claude", "installed"), { ...app("opencode", "missing"), install: undefined }]), undefined);
  // A connector that is not Cotal's own installs only from its row, which names its package.
  assert.equal(suggestedApp([app("claude", "installed"), app("thing", "missing", { package: "cotal-connector-thing" })]), undefined);
});

test("the list is refused unless every row has a known shape", () => {
  assert.equal(parseApps({ apps: [app("claude", "signed-in")] }).length, 1);
  for (const apps of [undefined, [{ name: "x", title: "x", state: "busy" }], [{ title: "x", state: "missing" }], [null]])
    assert.throws(() => parseApps({ apps } as Record<string, unknown>), /unsupported/);
});

test("sign-in pages are only https addresses the CLI printed", () => {
  assert.equal(signInUrl("https://claude.ai/oauth/authorize?code=true&state=abc"), "https://claude.ai/oauth/authorize?code=true&state=abc");
  assert.equal(signInUrl("If the browser didn't open, visit: https://auth.openai.com/x \"quoted\""), "https://auth.openai.com/x");
  assert.equal(signInUrl("http://localhost:1455/callback"), undefined);
  assert.equal(signInUrl("Opening browser to sign in…"), undefined);
});

test("a refusal shows its first line, and its installer output as detail", () => {
  const refusal = new DaemonRefusal("OPERATION_FAILED", "the installer stopped with exit code 1\nNext: choose Check again", "INSTALLER_FAILED", undefined, "curl: (6) Could not resolve host" as unknown as Record<string, unknown>);
  assert.equal(refusalMessage(refusal), "The installer stopped with exit code 1");
  assert.equal(refusalDetail(refusal), "curl: (6) Could not resolve host");
  assert.equal(refusalDetail(new Error("x")), undefined);
  assert.equal(refusalMessage(new Error("")), "The operation could not finish");
});

test("a finished install says it is installed, also when the background service has not picked it up yet", () => {
  assert.equal(installedMessage("Hermes", { serviceRefresh: { state: "refreshed" } }), "Hermes is installed.");
  assert.equal(installedMessage("Codex", { pathAdded: "your user PATH" }), "Codex is installed. Cotal added its folder to PATH in your user PATH.");
  assert.equal(installedMessage("Pi", { serviceRefresh: { state: "pending", reason: "agents-running" } }), "Pi is installed. Your spaces can use it once the running agents finish.");
  assert.equal(installedMessage("Hermes", { serviceRefresh: { state: "pending", reason: "unconfirmed" } }), "Hermes is installed. Cotal couldn't confirm that the background service can use it. Choose Check again.");
  // The sign-in that follows an install keeps what the service has not done yet.
  assert.equal(installedMessage("Codex", {}, true), "Codex is ready.");
  assert.equal(installedMessage("Codex", { serviceRefresh: { state: "refreshed" }, pathAdded: "your user PATH" }, true), "Codex is ready. Cotal added its folder to PATH in your user PATH.");
  assert.equal(installedMessage("Claude Code", { serviceRefresh: { state: "pending", reason: "agents-running" } }, true), "Claude Code is signed in. Your spaces can use it once the running agents finish.");
  assert.equal(installedMessage("Claude Code", { serviceRefresh: { state: "pending", reason: "unconfirmed" } }, true), "Claude Code is signed in. Cotal couldn't confirm that the background service can use it. Choose Check again.");
});
