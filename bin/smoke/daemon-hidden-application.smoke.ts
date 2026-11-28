/**
 * The applications sentence follows the service's cached report, not a unit file.
 *
 * A hosted Manager refusal is a record the daemon already returns from `managers.all()` without
 * refresh. The first status-watch frame is that cache. While the account is signed out the CLI
 * records nothing from it. The names it would record are the connector rows whose reason says the
 * harness binary is missing and this shell can run that binary. `refreshedDaemonPath` is the repair
 * the sentence names. It does not decide the sentence.
 *
 * Run: tsx bin/smoke/daemon-hidden-application.smoke.ts
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { spaceSegment } from "@cotal-ai/workspace";
import { resolveHarness } from "../../implementations/manager/src/harness-resolution.js";
import { cachedDaemonStatus } from "../daemon/client.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { refreshedDaemonPath } from "../daemon/install.js";
import { serveDaemon } from "../daemon/server.js";
import { applicationsHiddenByReport } from "../daemon/service-hidden.js";

if (process.platform !== "linux") skipSuite("daemon-hidden-application: the cached report is read on the Linux service socket");

const root = mkdtempSync(join(tmpdir(), "cotal-hidden-app-"));
chmodSync(root, 0o700);
const runtime = mkdtempSync("/tmp/cotal-rt-");
const saved = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, COTAL_HOME: process.env.COTAL_HOME };
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;
process.env.XDG_RUNTIME_DIR = runtime;
process.env.COTAL_HOME = join(home, ".cotal");
mkdirSync(process.env.COTAL_HOME, { mode: 0o700 });

const bin = join(root, "apps");
mkdirSync(bin, { mode: 0o700 });
writeFileSync(join(bin, "aa-bin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const previousPath = process.env.PATH;
process.env.PATH = `${bin}:${previousPath ?? ""}`;

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`); };
const paths = daemonPaths();
const daemon = await serveDaemon({ paths, version: "0.0.0-hidden-app", peerUid: (sock) => peerCredentials(sock).uid });
try {
  const space = "seen";
  const refusal = join(process.env.COTAL_HOME, "daemon", spaceSegment(space), "manager-refusal.json");
  mkdirSync(join(refusal, ".."), { recursive: true, mode: 0o700 });
  const reason = "aa harness needs aa-bin on PATH - not found";
  writeFileSync(refusal, JSON.stringify({ space, state: "refused", restarts: 0, connectors: [{ agent: "aa", state: "unavailable", reason }] }), { mode: 0o600 });
  const frame = await cachedDaemonStatus({ paths });
  const manager = frame?.managers?.find((row) => row.connectors?.some((connector) => connector.agent === "aa"));
  const connector = manager?.connectors?.find((row) => row.agent === "aa");
  check("the first frame is the cached refusal and a signed-out account",
    frame?.account?.mode === "signed-out" && manager?.state === "refused" && connector?.state === "unavailable" && connector.reason === reason);
  check("a signed-out report names no application", applicationsHiddenByReport(frame, false).length === 0);
  const signedIn = { ...frame!, account: { ...frame!.account, mode: "account" } };
  check("the daemon's own row names the application when the account is not signed out",
    applicationsHiddenByReport(signedIn, true).join() === "aa");
  const available = { ...signedIn, managers: [{ connectors: [{ agent: "aa", state: "available", reason }] }] };
  check("an available row names nothing, which is the report after the service can see it",
    applicationsHiddenByReport(available, true).length === 0);
  const unit = `[Service]\nEnvironment=PATH="/usr/bin:/bin"\nExecStart="/bin/true"\n`;
  const refreshed = refreshedDaemonPath("systemd-user", unit, `${bin}:/usr/bin:/bin`);
  const repaired = /Environment=PATH="((?:\\.|[^"\\])*)"/.exec(refreshed ?? "")?.[1]?.replace(/\\([\\"])/g, "$1");
  const savedPath = process.env.PATH;
  process.env.PATH = repaired;
  const seen = resolveHarness("aa", ["aa-bin"]);
  process.env.PATH = savedPath;
  const afterRepair = { ...signedIn, managers: [{ connectors: [{ agent: "aa", state: seen.reason ? "unavailable" : "available", reason: seen.reason }] }] };
  check("the unit repair adds this shell's folder, and the sentence is gone once the service reports that PATH",
    repaired?.split(":").includes(bin) === true && seen.reason === undefined && applicationsHiddenByReport(afterRepair, true).length === 0);
  const already = `[Service]\nEnvironment=PATH="${bin}:/usr/bin:/bin"\nExecStart="/bin/true"\n`;
  const kept = refreshedDaemonPath("systemd-user", already, `${bin}:/usr/bin:/bin`);
  const keptPath = /Environment=PATH="((?:\\.|[^"\\])*)"/.exec(kept ?? "")?.[1]?.replace(/\\([\\"])/g, "$1");
  process.env.PATH = keptPath;
  const alreadySeen = resolveHarness("aa", ["aa-bin"]);
  process.env.PATH = savedPath;
  const alreadyReported = { ...signedIn, managers: [{ connectors: [{ agent: "aa", state: alreadySeen.reason ? "unavailable" : "available", reason: alreadySeen.reason }] }] };
  check("a unit that already gives the service the folder is not reported missing",
    keptPath?.split(":").includes(bin) === true && alreadySeen.reason === undefined && applicationsHiddenByReport(alreadyReported, true).length === 0);
} finally {
  await daemon.close();
  process.env.PATH = previousPath;
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  if (saved.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR;
  if (saved.COTAL_HOME === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = saved.COTAL_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
}
console.log(`daemon-hidden-application: ${checks} checks`);
