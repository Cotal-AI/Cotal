/** `cotal daemon setup` progress lines for an already-installed unit across no-refresh, refresh+restart, and refresh+failed-restart. */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { DAEMON_PROTOCOL_VERSION, daemonPaths } from "../daemon/endpoint.js";
import { generationOf, holdLifetime } from "../daemon/lifetime.js";

if (process.platform !== "linux") skipSuite("daemon-setup-path-report: Linux recording supervisor only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntry = join(repo, "bin/dist/cotal.js");
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
const root = mkdtempSync(join(tmpdir(), "dspr-"));

const idpServer = createHttpServer((_req, res) => { res.writeHead(404).end("{}"); });
await new Promise<void>(resolve => idpServer.listen(0, "127.0.0.1", resolve));
const idp = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}/api/auth`;

interface CellOptions {
  readonly name: string;
  readonly refreshWanted: boolean;
  readonly startFails: boolean;
}

async function runCell(opts: CellOptions): Promise<void> {
  const dir = join(root, opts.name);
  const home = join(dir, "home"), cotalHome = join(dir, "cotal"), config = join(dir, "config");
  const runtime = join(dir, "rt"), native = join(dir, "native"), extraBin = join(dir, "extra-bin"), scratch = join(dir, "tmp");
  for (const path of [home, cotalHome, config, runtime, native, extraBin, scratch]) mkdirSync(path, { recursive: true, mode: 0o700 });

  const basePath = [...new Set([native, ...(process.env.PATH ?? "").split(":").filter(isAbsolute)])].join(":");
  if (opts.refreshWanted) {
    writeFileSync(join(extraBin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: opts.refreshWanted ? `${extraBin}:${basePath}` : basePath,
    HOME: home,
    USER: "smoke",
    LOGNAME: "smoke",
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: scratch,
    COTAL_HOME: cotalHome,
    COTAL_ALLOW_CHECKOUT_SEED: "1",
    COTAL_SKIP_CONNECTOR_SEED: "1",
    COTAL_TELEMETRY: "off",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };

  const paths = daemonPaths(env, cotalHome);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });

  const unit = "cotal-daemon.service";
  const unitPath = join(config, "systemd", "user", unit);
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  const initialUnit = [
    "[Unit]",
    "Description=Cotal machine daemon",
    "",
    "[Service]",
    "Type=notify",
    "NotifyAccess=all",
    "TimeoutStartSec=60",
    `Environment=PATH="${basePath}"`,
    "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
    `ExecStart="${process.execPath}" "${cliEntry}" "daemon" "serve"`,
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=90",
    "KillMode=mixed",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  writeFileSync(unitPath, initialUnit, { mode: 0o600 });
  const receiptPath = join(paths.state, "service-unit.json");
  writeFileSync(receiptPath, `${JSON.stringify({
    v: 1,
    mechanism: "systemd-user",
    unit,
    unitPath,
    unitSha256: createHash("sha256").update(initialUnit).digest("hex"),
    installedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const nativeCalls: string[] = [];
  const ops: string[] = [];
  let restarted = false;

  const lifetime = holdLifetime(paths.lock);
  const daemon = createSocketServer(peer => {
    peer.setEncoding("utf8");
    let buffer = "";
    peer.on("data", chunk => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf("\n")) !== -1;) {
        const req = JSON.parse(buffer.slice(0, nl)) as { id: string; v: number; op: string };
        buffer = buffer.slice(nl + 1);
        ops.push(req.op);
        if (req.op === "spaces") {
          peer.write(`${JSON.stringify({
            v: DAEMON_PROTOCOL_VERSION,
            id: req.id,
            ok: true,
            result: { spaces: [], signedInProviders: [idp], failedProviders: [], refresh: "ok" },
          })}\n`);
          continue;
        }
        const connectors = opts.refreshWanted && !restarted
          ? [{ agent: "claude", state: "unavailable", reason: "claude harness needs claude on PATH" }]
          : [{ agent: "claude", state: "available" }];
        const managers = [{ space: "alpha", state: "answering", instanceId: "mgr_1", connectors }];
        const account = {
          idpUrl: idp,
          sub: "user_1",
          label: "smoke@example.test",
          computer: "smoke-host",
          machineId: "11111111-1111-4111-8111-111111111111",
          mode: "account",
          hostSupport: "supported",
          lastRegistration: new Date().toISOString(),
          spaces: [{ space: "alpha", desired: true, observed: "answering" }],
        };
        peer.write(`${JSON.stringify({
          v: DAEMON_PROTOCOL_VERSION,
          id: req.id,
          ok: true,
          result: {
            state: "ready",
            version,
            protocol: DAEMON_PROTOCOL_VERSION,
            pid: process.pid,
            managers,
            account: { ...account, accounts: [account] },
          },
        })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(paths.socket, resolve));
  chmodSync(paths.socket, 0o600);
  lifetime.publishing(generationOf(paths.socket));

  const control = createHttpServer((req, res) => {
    nativeCalls.push(req.url!);
    if (req.url === "/start") {
      if (opts.startFails) {
        res.writeHead(500).end("unit start denied by fixture");
        return;
      }
      restarted = true;
    }
    res.end("ok");
  });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  const controlPort = (control.address() as AddressInfo).port;

  writeFileSync(join(native, "systemctl"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") === "--user show-environment") {
  console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});
  process.exit(0);
}
const op = args.includes("daemon-reload") ? "daemon-reload" : args.at(-2);
if (!["daemon-reload", "stop", "start"].includes(op)) process.exit(99);
fetch(${JSON.stringify(`http://127.0.0.1:${controlPort}/`)} + op).then(async r => {
  if (!r.ok) { console.error(await r.text()); process.exit(1); }
}).catch(() => process.exit(99));
`, { mode: 0o700 });

  try {
    const child = spawn(process.execPath, [cliEntry, "daemon", "setup", "--json"], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    const serviceLines = stderr.trim().split("\n").filter(line => line.startsWith("service: "));
    const diskUnit = readFileSync(unitPath, "utf8");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { unitSha256: string };

    assert.ok(!stderr.includes("it was left as it is"), `${opts.name}: setup must never print the untrue 'it was left as it is' claim: ${stderr}`);
    assert.ok(!stderr.includes("refreshed the pinned PATH from this invocation"), `${opts.name}: old refresh wording removed: ${stderr}`);

    if (!opts.refreshWanted) {
      assert.equal(code, 0, `${opts.name}: expected exit 0: ${stdout}\n${stderr}`);
      assert.deepEqual(serviceLines, [
        `service: ${unit} is already installed`,
        `service: the daemon answers at ${paths.socket}`,
      ], `${opts.name}: exact service progress lines when no refresh is planned`);
      assert.deepEqual(nativeCalls, [], `${opts.name}: no native reload/stop/start calls`);
      assert.equal(diskUnit, initialUnit, `${opts.name}: unit file untouched when no refresh runs`);
      const doc = JSON.parse(stdout) as { result: { steps: { step: string; outcome: string; detail: string }[] } };
      assert.deepEqual(
        doc.result.steps.filter(step => step.step === "install"),
        [{ step: "install", outcome: "already-installed", detail: `${unit} is already installed` }],
      );
      console.log(`  ✓ ${opts.name}: prints '${unit} is already installed' and leaves unit untouched`);
      return;
    }

    if (!opts.startFails) {
      assert.equal(code, 0, `${opts.name}: expected exit 0: ${stdout}\n${stderr}`);
      assert.deepEqual(serviceLines, [
        `service: ${unit} is already installed`,
        `service: the daemon answers at ${paths.socket}`,
        "service: waiting for hosted Managers to confirm readiness and an idle restart fence; readiness observation waits up to 15s",
        `service: updating ${unit} pinned PATH`,
        `service: restarted ${unit} with the updated PATH`,
      ], `${opts.name}: exact line order when refresh and restart both succeed`);
      assert.deepEqual(nativeCalls, ["/daemon-reload", "/stop", "/start"], `${opts.name}: reload, stop, start ran in order`);
      assert.ok(diskUnit.includes(`Environment=PATH="${[extraBin, basePath, join(home, ".local/bin"), join(home, ".opencode/bin"), join(home, ".pi/agent/bin")].join(":")}"`), `${opts.name}: unit file pins new PATH directory`);
      assert.equal(receipt.unitSha256, createHash("sha256").update(diskUnit).digest("hex"), `${opts.name}: receipt matches updated unit`);
      const doc = JSON.parse(stdout) as { result: { steps: { step: string; outcome: string; detail: string }[] } };
      assert.deepEqual(
        doc.result.steps.filter(step => step.step === "install"),
        [
          { step: "install", outcome: "already-installed", detail: `${unit} is already installed` },
          { step: "install", outcome: "path-refreshed", detail: `restarted ${unit} with the updated PATH` },
        ],
      );
      console.log(`  ✓ ${opts.name}: prints updating before rewrite and restarted after restart succeeds`);
      return;
    }

    assert.equal(code, 3, `${opts.name}: expected exit 3 on native start failure: ${stdout}\n${stderr}`);
    assert.deepEqual(serviceLines, [
      `service: ${unit} is already installed`,
      `service: the daemon answers at ${paths.socket}`,
      "service: waiting for hosted Managers to confirm readiness and an idle restart fence; readiness observation waits up to 15s",
      `service: updating ${unit} pinned PATH`,
    ], `${opts.name}: exact line order when refresh succeeds and restart fails (no 'restarted' line)`);
    assert.ok(!stderr.includes(`restarted ${unit} with the updated PATH`), `${opts.name}: must not claim unit restarted when start failed`);
    assert.deepEqual(nativeCalls, ["/daemon-reload", "/stop", "/start"], `${opts.name}: reload, stop, start attempted`);
    assert.ok(ops.includes("managers-abort-restart"), `${opts.name}: aborts restart fence after native failure`);
    assert.ok(diskUnit.includes(`Environment=PATH="${[extraBin, basePath, join(home, ".local/bin"), join(home, ".opencode/bin"), join(home, ".pi/agent/bin")].join(":")}"`), `${opts.name}: unit rewrite already occurred after 'updating' line`);
    assert.equal(receipt.unitSha256, createHash("sha256").update(diskUnit).digest("hex"), `${opts.name}: receipt matches rewritten unit`);
    const doc = JSON.parse(stdout) as { outcome: string; error?: { code: string; message: string } };
    assert.equal(doc.outcome, "unknown");
    assert.equal(doc.error?.code, "OPERATION_UNKNOWN");
    assert.match(doc.error?.message ?? "", /the native daemon start did not confirm completion \(unit start denied by fixture\); it was not retried/);
    console.log(`  ✓ ${opts.name}: prints updating before rewrite, omits restarted on failure, and preserves refusal`);
  } finally {
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    lifetime.release();
    await new Promise<void>(resolve => control.close(() => resolve()));
    if (existsSync(paths.socket)) rmSync(paths.socket, { force: true });
  }
}

try {
  await runCell({ name: "no-refresh", refreshWanted: false, startFails: false });
  await runCell({ name: "refresh-and-restart-succeed", refreshWanted: true, startFails: false });
  await runCell({ name: "refresh-succeeds-restart-fails", refreshWanted: true, startFails: true });
} finally {
  await new Promise<void>(resolve => idpServer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
emitSentinel({ passed: counted.cells(), failed: 0 });
