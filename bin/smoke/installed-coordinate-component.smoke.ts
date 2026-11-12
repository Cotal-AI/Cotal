/** Synthetic component coverage only. No daemon, native registration or host service is invoked. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedCoordinate } from "../daemon/installed-coordinate.js";
import { renderDaemonUnit } from "../daemon/install.js";

if (process.platform !== "linux") {
  assert.throws(() => installedCoordinate({ state: "/absent", socket: "/absent", lock: "/absent" }), /require Linux/);
  console.log("PASS non-Linux refusal");
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordinate-component-")));
  const original = { argv: process.argv, execArgv: process.execArgv, path: process.env.PATH };
  try {
    const home = join(root, "home"), units = join(root, "config/systemd/user"), commands = join(root, "commands"), runtime = join(root, "runtime"), dist = join(runtime, "dist");
    for (const dir of [home, units, commands, dist]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = join(dist, "cotal.js");
    writeFileSync(entry, "// synthetic trusted CLI entry\n", { mode: 0o600 });
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }), { mode: 0o600 });
    const calls = join(root, "calls");
    writeFileSync(join(commands, "systemctl"), `#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = --user ] && [ "$2" = show-environment ] || exit 91\nprintf 'query\\n' >> '${calls}'\nprintf 'XDG_CONFIG_HOME=${join(root, "config")}\\n'\n`, { mode: 0o700 });
    process.env.PATH = commands;
    process.argv = [process.execPath, entry];
    process.execArgv = [];
    const paths = { state: home, lock: join(home, "daemon.lock"), socket: join(home, "daemon.sock") };
    const rendered = renderDaemonUnit(units, home);
    const receiptPath = join(home, "service-unit.json");
    const receipt = { v: 1, mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: "2026-11-12T00:00:00.000Z", daemonHome: home };
    const saveReceipt = (value: unknown = receipt) => writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
    const saveSource = (value = rendered.bytes) => writeFileSync(rendered.unitPath, value, { mode: 0o600 });
    saveSource(); saveReceipt();
    const observe = () => installedCoordinate(paths, home);
    const first = observe();
    assert.equal(first.snapshot.uid, process.getuid!());
    assert.equal(first.snapshot.authentication, "local-installation-only");
    assert.equal(first.snapshot.runtime.kind, "unpackaged");
    assert.deepEqual(first.snapshot.invocation.nodeArguments, ["--max-semi-space-size=1"]);
    assert.deepEqual(first.snapshot.invocation.daemonArguments, ["daemon", "serve", "--daemon-home", home]);
    assert.equal(first.sha256, createHash("sha256").update(JSON.stringify(first.snapshot)).digest("hex"));
    assert.deepEqual(observe(), first);
    assert.equal(readFileSync(rendered.unitPath, "utf8"), rendered.bytes);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt);
    saveReceipt({ ...receipt, extra: true }); assert.throws(observe); saveReceipt();
    saveReceipt({ ...receipt, installedAt: "yesterday" }); assert.throws(observe); saveReceipt();
    saveReceipt({ ...receipt, unitPath: join(root, "foreign") }); assert.throws(observe); saveReceipt();
    saveSource(`${rendered.bytes}ExecStart=/evil\n`); assert.throws(observe);
    saveReceipt({ ...receipt, unitSha256: createHash("sha256").update(readFileSync(rendered.unitPath)).digest("hex") });
    assert.throws(observe, /trusted serving invocation/); saveSource(); saveReceipt();
    chmodSync(receiptPath, 0o644); assert.throws(observe, /private/); chmodSync(receiptPath, 0o600);
    chmodSync(rendered.unitPath, 0o644); assert.throws(observe, /private/); chmodSync(rendered.unitPath, 0o600);
    unlinkSync(rendered.unitPath); symlinkSync(entry, rendered.unitPath); assert.throws(observe); unlinkSync(rendered.unitPath); saveSource();
    const alias = join(root, "alias"); symlinkSync(home, alias); assert.throws(() => installedCoordinate({ ...paths, state: alias }, alias), /canonical/);
    const manifest = join(runtime, "desktop-runtime.json");
    writeFileSync(manifest, "{}", { mode: 0o600 }); assert.throws(observe, /manifest is malformed/);
    writeFileSync(manifest, JSON.stringify({ schema: 1, version: "0.1.0", target: "x86_64-unknown-linux-gnu", node: "24.0.0", files: { "dist/cotal.js": "a".repeat(64) } }));
    assert.equal(observe().snapshot.runtime.kind, "local-manifest");
    unlinkSync(manifest); symlinkSync(entry, manifest); assert.throws(observe); unlinkSync(manifest);
    unlinkSync(entry); assert.throws(observe); writeFileSync(entry, "// synthetic trusted CLI entry\n", { mode: 0o600 });
    assert.deepEqual(observe(), first);
    const effectiveUid = process.geteuid;
    try {
      process.geteuid = () => process.getuid!() + 1;
      assert.throws(observe, /real and effective uid differ/);
    } finally { process.geteuid = effectiveUid; }
    chmodSync(entry, 0o620); assert.throws(observe, /protected regular file/); chmodSync(entry, 0o600);
    chmodSync(dist, 0o720); assert.throws(observe); chmodSync(dist, 0o700);
    const pathLine = rendered.bytes.split("\n").find(line => line.startsWith("Environment=PATH="))!;
    const changedPath = rendered.bytes.replace(pathLine, 'Environment=PATH="/other/bin"');
    saveSource(changedPath);
    saveReceipt({ ...receipt, unitSha256: createHash("sha256").update(changedPath).digest("hex") });
    assert.deepEqual(observe().snapshot.invocation, first.snapshot.invocation);
    for (const addition of ["ExecStart=/evil\n", "ExecStartPre=/evil\n", `${pathLine}\n`]) {
      const changed = `${changedPath}${addition}`;
      saveSource(changed); saveReceipt({ ...receipt, unitSha256: createHash("sha256").update(changed).digest("hex") });
      assert.throws(observe);
    }
    saveSource(); saveReceipt();
    saveReceipt({ ...receipt, mechanism: "launchd-agent" }); assert.throws(observe); saveReceipt();
    saveReceipt({ ...receipt, daemonHome: join(root, "other") }); assert.throws(observe); saveReceipt();
    saveReceipt({ ...receipt, unit: "foreign.service" }); assert.throws(observe); saveReceipt();
    writeFileSync(receiptPath, " ".repeat(16 * 1024 + 1)); assert.throws(observe, /byte limit/); saveReceipt();
    unlinkSync(receiptPath); assert.throws(observe, /absent/); saveReceipt();
    writeFileSync(manifest, "not json", { mode: 0o600 }); assert.throws(observe); unlinkSync(manifest);
    // The fixture query changes the receipt after its first read. This is ordinary change
    // detection coverage, not proof of atomicity or exclusion of a same-user writer.
    writeFileSync(join(commands, "systemctl"), `#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = --user ] && [ "$2" = show-environment ] || exit 91\nprintf ' ' >> '${receiptPath}'\nprintf 'query\\n' >> '${calls}'\nprintf 'XDG_CONFIG_HOME=${join(root, "config")}\\n'\n`);
    assert.throws(observe, /changed during observation/);
    assert.match(readFileSync(calls, "utf8"), /^(query\n)+$/);
    console.log("PASS installed-coordinate synthetic component: stable snapshot, same-byte renderer validation, strict receipt, protected reads, canonical paths, manifest refusal and no native service actions");
  } finally {
    process.argv = original.argv; process.execArgv = original.execArgv;
    if (original.path === undefined) delete process.env.PATH; else process.env.PATH = original.path;
    rmSync(root, { recursive: true, force: true });
  }
}
