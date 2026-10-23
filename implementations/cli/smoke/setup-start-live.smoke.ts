/** Live regression for #4421: implicit local addresses and classified setup startup refusals.
 * Run: pnpm smoke:setup-start:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(ROOT, "bin", "dist", "cotal.js");
const home = mkdtempSync(join(tmpdir(), "cotal-setup-start-"));
const host = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR"].includes(key)));
const env: Record<string, string | undefined> = { ...host, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "home"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", NO_COLOR: "1" };
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, env);
const { check, finish } = createSuite();
interface Receipt { outcome: string; error?: { code: string; message: string }; result?: { server?: string; startup?: { state: string; failure?: { code: string; message?: string } } } }
const unconfirmed = new Set<string>();
const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let receipt: Receipt | undefined;
  try { receipt = JSON.parse(r.stdout) as Receipt; } catch { /* Printed below if the command failed. */ }
  if (args[0] === "up" && (r.status === null || receipt?.outcome === "unknown")) unconfirmed.add(cwd);
  return { status: r.status, receipt, stdout: r.stdout, stderr: r.stderr };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-1000) });
const project = (name: string) => {
  const path = join(home, name); mkdirSync(path);
  const r = run(path, "space", "create", name, "--root", path);
  check(`${name} is prepared through the CLI`, r.status === 0, shown(r));
  return path;
};
// This connector only admits setup's preparation. Refusal cases must stop at
// the broker guard before the external application could be launched.
const connector = join(home, "connector.mjs");
writeFileSync(connector, `import { registry } from ${JSON.stringify(pathToFileURL(join(ROOT, "packages/core/dist/index.js")).href)};
registry.register({ kind: "connector", name: "setup-smoke", requires: [], buildLaunch() { throw new Error("unexpected harness launch"); } });
`);
const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const active: string[] = [];
try {
  check("the built CLI exists", existsSync(BIN));
  const held = join(home, "held"); mkdirSync(held); mkdirSync(join(held, ".cotal"));
  const reserve = run(held, "space", "add", "held", "--server", "nats://127.0.0.1:4222", "--root", held, "--mode", "open", "--force", "--yes");
  check("a real space-add command reserves the default address without a listener", reserve.status === 0, shown(reserve));

  if (!selected || selected === "address") {
    const root = project("second");
    active.push(root);
    const started = run(root, "up", "--space", "second", "--open", "--no-manager");
    check("a fresh implicit startup avoids another registration's address", started.status === 0 && started.receipt?.result?.server !== "nats://127.0.0.1:4222", shown(started));
    if (started.status === 0) {
      const journal = JSON.parse(readFileSync(join(root, ".cotal", "stack-controller.json"), "utf8")) as { server: string };
      check("the selected address is saved in the stack journal", journal.server === started.receipt?.result?.server);
      const again = run(root, "up", "--space", "second", "--open", "--no-manager");
      check("a repeat startup keeps its recorded address", again.status === 0 && again.receipt?.result?.server === journal.server, shown(again));
      const other = project("third");
      active.push(other);
      const parallel = run(other, "up", "--space", "third", "--open", "--no-manager");
      check("two separate spaces run together on distinct recorded addresses", parallel.status === 0 && parallel.receipt?.result?.server !== journal.server && parallel.receipt?.result?.server !== "nats://127.0.0.1:4222", shown(parallel));

    }
  }

  if (!selected || selected === "refusal") {
    const root = project("refused");
    const refused = run(root, "up", "--space", "refused", "--server", "nats://127.0.0.1:4222", "--open", "--no-manager");
    check("an explicit reserved address is a confirmed CONFLICT", refused.status === 2 && refused.receipt?.error?.code === "CONFLICT", shown(refused));
    const { startSetupLocalStack } = await import("../src/commands/setup-start.js");
    const original = process.argv[1]; process.argv[1] = BIN;
    let failure: { outcome?: string; code?: string; message?: string } | undefined;
    try { await startSetupLocalStack(root, "refused"); }
    catch (error) { failure = error as typeof failure; }
    finally { process.argv[1] = original; }
    check("setup preserves the native child's confirmed CONFLICT", failure?.outcome === "refused" && failure.code === "CONFLICT", failure);
    check("setup preserves the classified conflict diagnostic", failure?.message?.includes("another registration names this exact broker address") === true, failure);
    env.NODE_OPTIONS = `${host.NODE_OPTIONS ?? ""} --import=${pathToFileURL(connector).href}`;
    const setup = run(root, "setup", "--destination", "local", "--harness", "setup-smoke", "--project", root, "--space", "refused", "--start", "--detach", "--yes");
    check("public setup reports a confirmed refusal with preparation saved", setup.status === 4 && setup.receipt?.result?.startup?.state === "refused" && setup.receipt.result.startup.failure?.code === "CONFLICT", shown(setup));
    check("public setup retains the actionable classified diagnostic", setup.receipt?.result?.startup?.failure?.message?.includes("another registration names this exact broker address") === true, shown(setup));
    const plain = spawnSync(process.execPath, [BIN, "setup", "--destination", "local", "--harness", "setup-smoke", "--project", root, "--space", "refused", "--start", "--detach", "--yes", "--plain"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    check("the human setup report names the classified conflict", plain.status === 4 && /Cause:?\s+CONFLICT/.test(plain.stdout) && plain.stdout.includes("another registration names this exact broker address"), plain.stdout);
    check("the human setup report distinguishes a confirmed refusal from an unknown command", plain.stdout.includes("Command refused") && !plain.stdout.includes("Command outcome unconfirmed"), plain.stdout);
    delete env.NODE_OPTIONS;

    // Exercise incomplete IPC at the actual spawn boundary. The hook terminates only
    // the hidden setup child before startup; it never substitutes a CLI executable.
    const cases = ["missing", "mismatched-exit", "wrong-space", "duplicate", "malformed", "signal", "raw-error"];
    for (const mode of cases) {
      const hook = join(home, "child-result.mjs");
      writeFileSync(hook, `if (process.argv[2] === "__setup-start") {
        const mode = ${JSON.stringify(mode)};
        if (mode === "signal") process.kill(process.pid, "SIGTERM");
        else if (mode === "raw-error") throw new Error("PRIVATE_NATIVE_MARKER");
        else if (mode === "missing") process.exit(2);
        else {
          const value = { type: "setup-start-failure", root: ${JSON.stringify(root)}, space: mode === "wrong-space" ? "other" : "refused", pid: process.pid, outcome: "refused", code: "CONFLICT", message: "fixture refusal" };
          if (mode === "malformed") value.extra = "unexpected";
          process.send(value, () => mode === "duplicate" ? process.send(value, () => process.exit(2)) : process.exit(mode === "mismatched-exit" ? 1 : 2));
        }
      }`);
      process.env.NODE_OPTIONS = `${host.NODE_OPTIONS ?? ""} --import=${pathToFileURL(hook).href}`;
      const entry = process.argv[1]; process.argv[1] = BIN;
      let unknown: { outcome?: string; code?: string; message?: string } | undefined;
      try { await startSetupLocalStack(root, "refused"); }
      catch (error) { unknown = error as typeof unknown; }
      finally { process.argv[1] = entry; delete process.env.NODE_OPTIONS; }
      check(`a ${mode} child result remains unknown without exposing raw diagnostics`, unknown?.outcome === "unknown" && unknown.code === "OPERATION_UNKNOWN" && !unknown.message?.includes("PRIVATE_NATIVE_MARKER"), unknown);
    }


  }
  if (!selected || selected === "success") {
    const root = project("guided");
    active.push(root);
    const { startSetupLocalStack } = await import("../src/commands/setup-start.js");
    const entry = process.argv[1]; process.argv[1] = BIN;
    try {
      const started = await startSetupLocalStack(root, "guided");
      const journal = JSON.parse(readFileSync(join(root, ".cotal", "stack-controller.json"), "utf8")) as { server: string };
      check("setup's native child starts an authenticated stack on an unreserved address", started.commandReturned && journal.server !== "nats://127.0.0.1:4222");
      check("successful setup startup retains its exact manager pin", started.managerInstanceId.length > 0 && started.coordinator.pid > 0 && started.readinessEstablished === false);
    } catch (error) {
      if ((error as { outcome?: string }).outcome === "unknown") unconfirmed.add(root);
      throw error;
    } finally { process.argv[1] = entry; }
  }

  if (!selected || selected === "validation") {
    const root = project("validation");
    const empty = join(home, "unprepared"); mkdirSync(empty);
    const nativeEnv = { ...env }; delete nativeEnv.COTAL_SKIP_CONNECTOR_SEED;
    for (const [path, version, label] of [[root, "0.0.0-invalid", "version mismatch"], [empty, JSON.parse(readFileSync(join(ROOT, "bin/package.json"), "utf8")).version as string, "changed preparation"]]) {
      const before = existsSync(join(env.XDG_CONFIG_HOME!, "cotal/extensions/extensions.json")) ? readFileSync(join(env.XDG_CONFIG_HOME!, "cotal/extensions/extensions.json"), "utf8") : undefined;
      const r = spawnSync(process.execPath, [BIN, "__setup-start", "--root", path!, "--space", "validation", "--expected-version", version!], { cwd: path, env: nativeEnv, encoding: "utf8", timeout: 120_000 });
      check(`native startup validates ${label} before connector reconciliation`, r.status === 2 && /different CLI versions|preparation\/root changed|already prepared in/.test(r.stderr), { status: r.status, stderr: r.stderr.slice(-1000) });
      const after = existsSync(join(env.XDG_CONFIG_HOME!, "cotal/extensions/extensions.json")) ? readFileSync(join(env.XDG_CONFIG_HOME!, "cotal/extensions/extensions.json"), "utf8") : undefined;
      check(`${label} does not change the extension manifest`, before === after);
    }
  }

  if (selected === "ipv6") {
    const root = project("ipv6");
    active.push(root);
    const started = run(root, "up", "--space", "ipv6", "--open", "--no-manager", "--host", "[::1]");
    check("the implicit allocator does not resolve IPv6 brackets as DNS", (started.status === 0 || started.receipt?.error?.code === "OPERATION_FAILED") && !started.receipt?.error?.message.includes("ENOTFOUND"), shown(started));
  }

  if (!selected || selected === "occupied") {
    const forgotten = run(held, "space", "forget", "held");
    check("the fixture reservation can be removed without touching another space", forgotten.status === 0, shown(forgotten));
    const socket = createServer();
    const listening = await new Promise<boolean>((resolve, reject) => {
      socket.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
      socket.listen(4222, "127.0.0.1", () => resolve(true));
    });
    try {
      const root = project("occupied");
      active.push(root);
      const started = run(root, "up", "--space", "occupied", "--open", "--no-manager");
        check("a fresh startup avoids an occupied default TCP socket", started.status === 0 && started.receipt?.result?.server !== "nats://127.0.0.1:4222", shown(started));
    } finally {
      if (listening) await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    }
  }
  finish();
} finally {
  // This reservation belongs to the fixture. Remove it before cleanup so a refused
  // attempt on that address is not mistaken for a request to stop a shared broker.
  run(home, "space", "forget", "held");
  for (const root of active.reverse()) {
    const stopped = run(root, "down", ...(existsSync(join(root, ".cotal", "stack-controller.json")) ? ["--yes"] : []));
    if (stopped.status !== 0) throw new Error(`cleanup did not confirm the owned stack stopped: ${JSON.stringify(shown(stopped))}`);
  }
  if (unconfirmed.size) throw new Error(`retained uncertain startup state at ${home}: ${[...unconfirmed].join(", ")}`);
  rmSync(home, { recursive: true, force: true });
}
