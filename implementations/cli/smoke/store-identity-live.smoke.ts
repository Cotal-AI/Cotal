/** A live stack must report a missing or replaced store before a restart loses its history. */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const managed = process.env.COTAL_STORE_IDENTITY_MANAGED === "1", custom = process.env.COTAL_STORE_IDENTITY_CUSTOM === "1";
const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}store-identity-`));
let root = join(sandbox, "project");
const outside = join(sandbox, "outside"), home = join(sandbox, "home"), xdg = join(sandbox, "xdg");
for (const dir of [root, outside, home, xdg]) mkdirSync(dir, { mode: 0o700 });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(sandbox, "runtime"), XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(sandbox, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
const outsideAnchor = recordSmokeSandbox({ root: outside, cotalHome: home, xdgConfigHome: xdg });
const space = `store-${randomUUID().slice(0, 8)}`;
type Envelope = { warnings?: { code: string; message: string; target?: { root?: string } }[]; result?: { selected?: { root?: string }; instances?: { observedProcess?: string }[]; messages?: unknown[] } };
const runAt = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 90_000 };
  assertSmokeSandboxDown(cwd === root ? anchor : outsideAnchor, args, options);
  const child = spawnSync(process.execPath, [bin, ...args], options);
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(child.stdout) as Envelope; } catch { envelope = undefined; }
  const result = { status: child.status, text: child.stdout + child.stderr, envelope };
  writeFileSync(join(sandbox, `${String(sequence++).padStart(2, "0")}-${args[0]}.json`), JSON.stringify(result, null, 2));
  return result;
};
const run = (...args: string[]) => runAt(root, ...args);
const selectedStatus = (...args: string[]) => runAt(outside, "status", "--space", space, ...args);
let sequence = 0;
let started = false;
let journalPath = join(root, ".cotal", "stack-controller.json");
const warning = (result: ReturnType<typeof run>, code: string) => result.envelope?.warnings?.find((row) => row.code === code);
const journal = () => JSON.parse(readFileSync(journalPath, "utf8")) as { broker: { storeDir: string; storeIdentity?: unknown } };
try {
  const prepared = run("space", "create", space, "--root", root, "--json");
  if (prepared.status !== 0) throw new Error(`space preparation failed: ${prepared.text}`);
  const port = await freePort();
  const up = run("up", "--server", `nats://127.0.0.1:${port}`, ...(managed ? [] : ["--no-manager"]), ...(custom ? ["--store-dir", join(sandbox, "custom-store")] : []), "--json");
  started = true;
  if (up.status !== 0) throw new Error(`initial start failed: ${up.text}`);
  suite.check("fresh startup gives no lost-store warning", !warning(up, "STORE_REPLACED") && !warning(up, "STORE_MISSING"), up.text);
  const sent = run("send", "--space", space, "-c", "general", "retained-before-replacement", "--json");
  if (sent.status !== 0) throw new Error(`initial send failed: ${sent.text}`);
  const history = run("history", "general", "--space", space, "--json");
  suite.check("the real broker retains the initial post", history.status === 0 && history.text.includes("retained-before-replacement"), history.text);
  const healthy = run("status", "--space", space, "--json");
  suite.check("unchanged store has no identity warning", !warning(healthy, "STORE_REPLACED") && !warning(healthy, "STORE_MISSING"), healthy.text);
  const compact = run("status", "--space", space);
  const verbose = run("status", "--verbose", "--space", space);
  const brokerExecutable = /^ +NATS: +(?:bundled )?nats-server \S+ (?:on PATH )?at \S/m;
  suite.check("compact status omits the healthy broker executable",
    compact.status === 0 && !brokerExecutable.test(compact.text) && !/^ +Broker executable:/m.test(compact.text), compact.text);
  suite.check("verbose status shows the selected broker executable and its path",
    verbose.status === 0 && brokerExecutable.test(verbose.text), verbose.text);
  const outsideHealthy = selectedStatus("--json");
  suite.check("outside-project selection reaches the healthy stack without a store warning", outsideHealthy.envelope?.result?.selected?.root === root && !warning(outsideHealthy, "STORE_REPLACED") && !warning(outsideHealthy, "STORE_MISSING"), outsideHealthy.text);

  const moved = join(sandbox, "moved-project");
  renameSync(root, moved);
  const movedDown = runAt(outside, "down", "--space", space, "--yes", "--json");
  if (movedDown.status !== 0) throw new Error(`moved-folder stop failed: ${movedDown.text}`);
  started = false;
  root = moved;
  journalPath = join(root, ".cotal", "stack-controller.json");
  anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  const adopted = run("space", "create", space, "--adopt", "--json");
  if (adopted.status !== 0) throw new Error(`moved-folder adoption failed: ${adopted.text}`);
  const adoptedPlain = run("status", "--plain");
  suite.check("adopted rename has clean folder status before starting", adoptedPlain.status === 0 && !/recorded store.*replaced/.test(adoptedPlain.text), adoptedPlain.text);
  const adoptedSelected = run("status", "--space", space, "--json");
  suite.check("adopted rename has clean selected status before starting", adoptedSelected.status === 0 && !warning(adoptedSelected, "STORE_REPLACED"), adoptedSelected.text);
  const movedUp = run("up", ...(managed ? [] : ["--no-manager"]), "--json");
  started = true;
  if (movedUp.status !== 0) throw new Error(`adopted restart failed: ${movedUp.text}`);
  const movedHistory = run("history", "general", "--space", space, "--json");
  suite.check("adopted restart retains the original post", movedHistory.status === 0 && movedHistory.text.includes("retained-before-replacement"), movedHistory.text);
  const movedStatus = run("status", "--space", space, "--json");
  suite.check("adopted restart has clean status", movedStatus.status === 0 && !warning(movedStatus, "STORE_REPLACED"), movedStatus.text);

  if (!custom) {
    const beforeCopyDown = run("down", "--yes", "--json");
    if (beforeCopyDown.status !== 0) throw new Error(`pre-copy stop failed: ${beforeCopyDown.text}`);
    started = false;
    const forgot = run("space", "forget", space, "--json");
    if (forgot.status !== 0) throw new Error(`pre-copy forget failed: ${forgot.text}`);
    const copied = join(sandbox, "copied-project");
    cpSync(root, copied, { recursive: true });
    rmSync(root, { recursive: true, force: true });
    root = copied;
    journalPath = join(root, ".cotal", "stack-controller.json");
    anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
    const copyAdopted = run("space", "create", space, "--adopt", "--json");
    if (copyAdopted.status !== 0) throw new Error(`copied-folder adoption failed: ${copyAdopted.text}`);
    const copyPlain = run("status", "--plain");
    suite.check("adopted copy has clean folder status before starting", copyPlain.status === 0 && !/recorded store.*replaced/.test(copyPlain.text), copyPlain.text);
    const copySelected = run("status", "--space", space, "--json");
    suite.check("adopted copy has clean selected status before starting", copySelected.status === 0 && !warning(copySelected, "STORE_REPLACED"), copySelected.text);
    const copyUp = run("up", ...(managed ? [] : ["--no-manager"]), "--json");
    started = true;
    if (copyUp.status !== 0) throw new Error(`copied-folder restart failed: ${copyUp.text}`);
    const copyHistory = run("history", "general", "--space", space, "--json");
    suite.check("adopted copy restart retains the original post", copyHistory.status === 0 && copyHistory.text.includes("retained-before-replacement"), copyHistory.text);
  }

  const store = journal().broker.storeDir;
  const before = lstatSync(store, { bigint: true });
  renameSync(store, `${store}.retained`);
  mkdirSync(store, { mode: 0o700 });
  const after = lstatSync(store, { bigint: true });
  if (before.dev === after.dev && before.ino === after.ino) throw new Error("fixture did not replace the store directory");
  writeFileSync(join(sandbox, "identity-change.txt"), `${before.dev}:${before.ino} -> ${after.dev}:${after.ino}\n`);
  const status = run("status", "--space", space, "--json");
  suite.check("status reports the replaced store while the broker runs", Boolean(warning(status, "STORE_REPLACED")), status.text);
  suite.check("coincident folder and selected roots report replacement once", status.envelope?.warnings?.filter((row) => row.code === "STORE_REPLACED").length === 1, status.text);
  const outsideReplaced = selectedStatus("--json");
  suite.check("outside-project JSON status reports the selected store replacement once", outsideReplaced.status === 4 && outsideReplaced.envelope?.warnings?.filter((row) => row.code === "STORE_REPLACED").length === 1 && warning(outsideReplaced, "STORE_REPLACED")?.target?.root === root, outsideReplaced.text);
  const outsidePlain = selectedStatus("--plain");
  suite.check("outside-project plain status reports replacement and history uncertainty", outsidePlain.status === 4 && /recorded store.*replaced/.test(outsidePlain.text) && /history/.test(outsidePlain.text), outsidePlain.text);
  const refresh = run("up", ...(managed ? [] : ["--no-manager"]), "--json");
  suite.check("a live up warns without accepting a new store identity", refresh.status === 0 && Boolean(warning(refresh, "STORE_REPLACED")), refresh.text);
  const preview = run("down", "--dry-run", "--json");
  suite.check("down preview reports the replaced store", preview.status === 0 && Boolean(warning(preview, "STORE_REPLACED")), preview.text);
  const plain = run("status", "--space", space, "--plain");
  suite.check("plain status warns about store replacement and retained history", /recorded store.*replaced/.test(plain.text) && /history/.test(plain.text), plain.text);
  const down = run("down", "--yes", "--json");
  suite.check("down stops the owned stack and reports the replaced store", down.status === 0 && Boolean(warning(down, "STORE_REPLACED")), down.text);
  const restart = run("up", ...(managed ? [] : ["--no-manager"]), "--json");
  suite.check("restart warns that a replacement store can start with empty history", restart.status === 0 && /history.*empty/.test(warning(restart, "STORE_REPLACED")?.message ?? ""), restart.text);
  const empty = run("history", "general", "--space", space, "--json");
  suite.check("replacement restart no longer has the original retained post", empty.status === 0 && !empty.text.includes("retained-before-replacement"), empty.text);
  const accepted = run("status", "--space", space, "--json");
  suite.check("a freshly started replacement is now the recorded store", !warning(accepted, "STORE_REPLACED") && !warning(accepted, "STORE_MISSING"), accepted.text);

  chmodSync(journalPath, 0);
  try {
    const unreadable = run("status", "--space", space, "--json");
    suite.check("status reports an unreadable stack journal", unreadable.status === 4 && Boolean(unreadable.envelope?.result) && warning(unreadable, "STACK_JOURNAL_UNREADABLE")?.target?.root === root, unreadable.text);
    const outsideUnreadable = selectedStatus("--json");
    suite.check("outside-project status names the selected unreadable journal", outsideUnreadable.status === 4 && outsideUnreadable.envelope?.result?.selected?.root === root && warning(outsideUnreadable, "STACK_JOURNAL_UNREADABLE")?.target?.root === root, outsideUnreadable.text);
  } finally { chmodSync(journalPath, 0o600); }

  const absent = `${store}.absent`;
  renameSync(store, absent);
  const missingStatus = run("status", "--space", space, "--json");
  suite.check("status reports a store that remains absent", Boolean(warning(missingStatus, "STORE_MISSING")), missingStatus.text);
  const outsideMissing = selectedStatus("--json");
  suite.check("outside-project status names the selected missing store", outsideMissing.status === 4 && Boolean(warning(outsideMissing, "STORE_MISSING")), outsideMissing.text);
  const missingDown = run("down", "--yes", "--json");
  suite.check("down reports a missing store without preventing shutdown", missingDown.status === 0 && Boolean(warning(missingDown, "STORE_MISSING")), missingDown.text);
  const missingUp = run("up", ...(managed ? [] : ["--no-manager"]), "--json");
  suite.check("missing-store restart keeps the existing empty-history warning", missingUp.status === 0 && /history starts empty/.test(warning(missingUp, "STORE_MISSING")?.message ?? ""), missingUp.text);
} finally {
  if (started) {
    chmodSync(journalPath, 0o600);
    const down = run("down", "--yes", "--json");
    const inventory = run("service", "--space", space, "--json");
    suite.check("native cleanup confirms all owned stack members are gone", down.status === 0 && inventory.status === 0 && inventory.envelope?.result?.instances?.every((row) => row.observedProcess === "gone" || row.observedProcess === "previous-boot") === true, down.text + inventory.text);
  }
  console.log(`Retained fixture and CLI receipts: ${sandbox}`);
}
// Exercise the same stopped-store operations through real starts, not a rendered configuration.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  for (const route of ["manifest", "legacy-recorded", "legacy-config", "prepared", "named-open"] as const) {
    const project = join(sandbox, route);
    mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });
    const selected = route.startsWith("legacy") ? route : `permissions-${route}`;
    const isolated = { ...env, COTAL_HOME: join(sandbox, `home-${route}`) };
    const pin = recordSmokeSandbox({ root: project, cotalHome: isolated.COTAL_HOME, xdgConfigHome: isolated.XDG_CONFIG_HOME });
    const cli = (...args: string[]) => {
      const options = { cwd: project, env: isolated, encoding: "utf8" as const, timeout: 120_000 };
      assertSmokeSandboxDown(pin, args, options);
      const result = spawnSync(process.execPath, [bin, ...args], options);
      let error: { code?: string; remedy?: string } | undefined;
      try { error = JSON.parse(result.stdout).error; } catch { error = undefined; }
      return { status: result.status, text: result.stdout + result.stderr, error };
    };
    const must = (args: string[]) => {
      const result = cli(...args);
      if (result.status !== 0) throw new Error(`${route}: ${args.join(" ")} failed: ${result.text}`);
      return result;
    };
    const store = route.startsWith("legacy") ? join(sandbox, `store-${route}`) : join(project, ".cotal", "nats");
    const start = route === "manifest" ? ["up", "-f", "cotal.yaml"] : ["up", "--no-manager"];
    const address = `nats://127.0.0.1:${await freePort()}`;
    if (route === "manifest") writeFileSync(join(project, "cotal.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${selected}\nbroker:\n  servers: ${address}\nchannels:\n  general: {}\n`);
    if (route === "prepared") must(["space", "create", selected]);
    try {
      must(route === "manifest" ? start : [...start, "--space", selected, "--server", address, ...(route.startsWith("legacy") ? ["--store-dir", store] : []), ...(route === "named-open" ? ["--open"] : [])]);
      must(["send", "--space", selected, "-c", "general", "retained-permission-marker"]);
      must(["down", "--yes"]);
      if (route === "named-open") {
        for (const target of ["store", "all"]) {
          const preview = must(["clean", target, "--dry-run"]);
          suite.check(`named open ${target} preview accepts its own retained streams`, /would remove/.test(preview.text) && existsSync(store), preview.text);
        }
        must(["clean", "store", "--force"]);
        suite.check("named open clean store removes its own store without a second-space conflict", !existsSync(store));
        must(["up", "--no-manager"]);
        must(["send", "--space", selected, "-c", "general", "retained-before-clean-all"]);
        must(["down", "--yes"]);
        must(["clean", "all", "--force"]);
        suite.check("named open clean all removes its own store", !existsSync(store));
        continue;
      }
      if (route === "legacy-config") {
        const removed = cli("space", "forget", selected);
        if (removed.status !== 0) throw new Error(removed.text);
      }
      const config = join(project, ".cotal", "auth", "server.conf");
      const before = readFileSync(config, "utf8"), entries = readdirSync(join(project, ".cotal")).sort();
      spawnSync("chmod", ["-R", "a-w", store]);
      const refused = cli(...start, "--json");
      suite.check(`${route} restart refuses read-only store before broker launch`, refused.status === 2 && refused.error?.code === "PERMISSION_DENIED", refused.text);
      suite.check(`${route} refusal leaves configuration and control entries unchanged`, readFileSync(config, "utf8") === before && JSON.stringify(readdirSync(join(project, ".cotal")).sort()) === JSON.stringify(entries));
      suite.check(`${route} remedy repairs the store root as well as JetStream`, refused.error?.remedy?.endsWith(`chmod -R u+w ${store}`) === true, refused.text);
      if (route === "prepared") {
        for (const args of [["reset", "store", selected, "--yes", "--json"], ["clean", "store", "--force"]]) {
          const cleanup = cli(...args);
          suite.check(`${args[0]} refuses an unwritable root without moving the store`, cleanup.status === 2 && (cleanup.error?.code === "PERMISSION_DENIED" || cleanup.text.includes("PERMISSION_DENIED")) && existsSync(store) && !readdirSync(join(project, ".cotal")).some((entry) => entry.startsWith(".cotal-clean-")), cleanup.text);
        }
      }
      const remedy = refused.error?.remedy?.match(/chmod -R u\+w .+$/)?.[0];
      if (!remedy || spawnSync("sh", ["-c", remedy]).status !== 0) throw new Error(`invalid remedy: ${refused.text}`);
      must(start);
      const history = must(["history", "general", "--space", selected]);
      suite.check(`${route} repaired restart retains history`, history.text.includes("retained-permission-marker"), history.text);
      must(["down", "--yes"]);
      // A reset leaves the stack an empty store its journal records; a clean leaves none.
      if (route === "prepared") must(["reset", "store", selected, "--yes"]);
      else must(["clean", "store", "--force", ...(route.startsWith("legacy") ? ["--store-dir", store] : [])]);
      suite.check(`${route} cleanup succeeds after the exact startup remedy`, route === "prepared" ? existsSync(store) && readdirSync(store).length === 0 : !existsSync(store));
    } finally {
      spawnSync("chmod", ["-R", "u+rwX", project]);
      if (existsSync(store)) spawnSync("chmod", ["-R", "u+rwX", store]);
      cli("down", "--yes");
    }
  }
}
suite.finish();
process.exit(process.exitCode ?? 0);
