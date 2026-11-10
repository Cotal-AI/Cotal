/** A live stack must report a missing or replaced store before a restart loses its history. */
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const managed = process.env.COTAL_STORE_IDENTITY_MANAGED === "1", custom = process.env.COTAL_STORE_IDENTITY_CUSTOM === "1";
const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}store-identity-`));
const root = join(sandbox, "project"), outside = join(sandbox, "outside"), home = join(sandbox, "home"), xdg = join(sandbox, "xdg");
for (const dir of [root, outside, home, xdg]) mkdirSync(dir, { mode: 0o700 });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(sandbox, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
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
const journalPath = join(root, ".cotal", "stack-controller.json");
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
  const store = journal().broker.storeDir;
  const sent = run("send", "--space", space, "-c", "general", "retained-before-replacement", "--json");
  if (sent.status !== 0) throw new Error(`initial send failed: ${sent.text}`);
  const history = run("history", "general", "--space", space, "--json");
  suite.check("the real broker retains the initial post", history.status === 0 && history.text.includes("retained-before-replacement"), history.text);
  const healthy = run("status", "--space", space, "--json");
  suite.check("unchanged store has no identity warning", !warning(healthy, "STORE_REPLACED") && !warning(healthy, "STORE_MISSING"), healthy.text);
  const outsideHealthy = selectedStatus("--json");
  suite.check("outside-project selection reaches the healthy stack without a store warning", outsideHealthy.envelope?.result?.selected?.root === root && !warning(outsideHealthy, "STORE_REPLACED") && !warning(outsideHealthy, "STORE_MISSING"), outsideHealthy.text);

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
    suite.check("status reports an unreadable stack journal", Boolean(warning(unreadable, "STACK_JOURNAL_UNREADABLE")), unreadable.text);
    const outsideUnreadable = selectedStatus("--json");
    suite.check("outside-project status names the selected unreadable journal", outsideUnreadable.status === 4 && Boolean(warning(outsideUnreadable, "STACK_JOURNAL_UNREADABLE")), outsideUnreadable.text);
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
suite.finish();
process.exit(process.exitCode ?? 0);
