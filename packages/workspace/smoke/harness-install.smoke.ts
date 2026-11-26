/** A connector's install declaration is checked where the manifest caches it and where an app reads it
 *  back, so a malformed one never becomes a command. Drives the shipped check and cache, and the six
 *  official connectors' real declarations. */
import assert from "node:assert/strict";
import { registry, type Connector } from "@cotal-ai/core";
import { cacheConnector, checkedHarnessInstall } from "../src/index.js";

let checks = 0;
const valid = {
  title: "Example", maker: "Example Inc",
  installers: {
    darwin: { script: "https://example.com/install.sh", shell: "bash", binDir: "~/.local/bin" },
    linux: { script: "https://example.com/install.sh", shell: "sh", env: { EXAMPLE_NON_INTERACTIVE: "1" }, binDir: "~/.example/bin", needs: ["node"] },
    win32: { script: "https://example.com/install.ps1", binDir: "%LOCALAPPDATA%\\Example\\bin" },
  },
  signIn: { status: ["example", "auth", "status"], login: ["example", "auth", "login"] },
};
assert.deepEqual(checkedHarnessInstall("example", ["example"], valid), valid); checks++;
assert.ok(Object.isFrozen(checkedHarnessInstall("example", ["example"], valid).installers.linux!.env)); checks++;

const refused: Array<[string, unknown, RegExp, (readonly string[])?]> = [
  ["http address", { ...valid, installers: { linux: { ...valid.installers.linux, script: "http://example.com/install.sh" } } }, /plain https address/],
  ["credentials in the address", { ...valid, installers: { linux: { ...valid.installers.linux, script: "https://user:pw@example.com/i.sh" } } }, /plain https address/],
  ["a quote that would leave PowerShell's string", { ...valid, installers: { win32: { ...valid.installers.win32, script: "https://example.com/i.ps1?x='+iex" } } }, /plain https address/],
  ["a POSIX installer without a shell", { ...valid, installers: { linux: { script: "https://example.com/i.sh", binDir: "~/.local/bin" } } }, /must name the shell/],
  ["a Windows installer that names a shell", { ...valid, installers: { win32: { ...valid.installers.win32, shell: "sh" } } }, /names no shell/],
  ["an absolute POSIX folder", { ...valid, installers: { linux: { ...valid.installers.linux, binDir: "/usr/local/bin" } } }, /must start with ~\//],
  ["a folder that climbs out of home", { ...valid, installers: { linux: { ...valid.installers.linux, binDir: "~/../../etc" } } }, /must start with ~\//],
  ["an unknown Windows folder variable", { ...valid, installers: { win32: { ...valid.installers.win32, binDir: "%SYSTEMROOT%\\System32" } } }, /must start with %LOCALAPPDATA%/],
  ["a variable that would set PATH", { ...valid, installers: { linux: { ...valid.installers.linux, env: { PATH: "/tmp" } } } }, /cannot set PATH/],
  ["an unknown system", { ...valid, installers: { freebsd: valid.installers.linux } }, /one or more of darwin, linux, win32/],
  ["no installer at all", { ...valid, installers: {} }, /one or more of/],
  ["a sign-in that runs another executable", { ...valid, signIn: { status: ["sh", "-c", "x"], login: ["example", "login"] } }, /starting with an executable the connector requires/],
  ["an unknown field", { ...valid, postInstall: "rm -rf ~" }, /unknown fields: postInstall/],
  ["nothing to install", valid, /requires no executable/, []],
];
for (const [what, raw, message, requires] of refused) {
  assert.throws(() => checkedHarnessInstall("example", requires ?? ["example"], raw), message, what); checks++;
}

// The manifest cache carries a valid declaration, omits an absent one and refuses a malformed one.
const base = { kind: "connector", name: "example", requires: ["example"], buildLaunch: () => { throw new Error("unused"); } } as unknown as Connector;
assert.deepEqual(cacheConnector({ ...base, install: valid } as Connector).install, valid); checks++;
assert.equal("install" in cacheConnector(base), false); checks++;
assert.throws(() => cacheConnector({ ...base, install: { ...valid, title: "" } } as unknown as Connector), /title and maker/); checks++;

// The six official connectors declare installs the check accepts.
await Promise.all(["connector-claude-code", "connector-codex", "connector-opencode", "pi", "connector-hermes", "connector-jcode"].map(pkg => import(`../../../extensions/${pkg}/dist/index.js`)));
const official = registry.all<Connector>("connector").filter(connector => connector.install);
assert.deepEqual(official.map(connector => connector.name).sort(), ["claude", "codex", "hermes", "jcode", "opencode", "pi"]); checks++;
for (const connector of official) {
  const cached = cacheConnector(connector).install!;
  assert.ok(cached.installers.darwin && cached.installers.linux, `${connector.name} installs on macOS and Linux`); checks++;
  assert.equal(Boolean(cached.installers.win32), connector.name !== "opencode", `${connector.name}: only OpenCode has no Windows installer`); checks++;
}
console.log(`harness-install: ${checks} checks passed`);
