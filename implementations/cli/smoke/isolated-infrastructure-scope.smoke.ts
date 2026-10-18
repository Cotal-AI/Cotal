/** Exact authority for the restore-only infrastructure phase, and the isolated broker's boot bound (no broker, no test runner). */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { infrastructureMaintenancePermissions, startIsolatedBroker } from "../src/lib/isolated-broker.js";
import { endpointPlaneStreamNames, hardenedAuthorityStreamNames } from "@cotal-ai/core";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const permissions = infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ_space", "KV_records_space", "EPJ_space"], ["KV_records_space", "KV_records_space"]);
const allow = ((permissions as { pub?: { allow?: string[] } }).pub?.allow ?? []);
const count = (subject: string) => allow.filter((entry) => entry === subject).length;

check("every named stream gets exactly one CREATE grant", count("$JS.API.STREAM.CREATE.EPJ_space") === 1 && count("$JS.API.STREAM.CREATE.KV_records_space") === 1, allow);
check("every named stream gets exactly one INFO grant", count("$JS.API.STREAM.INFO.EPJ_space") === 1 && count("$JS.API.STREAM.INFO.KV_records_space") === 1, allow);
check("the named update stream gets exactly one UPDATE grant", count("$JS.API.STREAM.UPDATE.KV_records_space") === 1, allow);
check("a non-update stream gets no UPDATE grant", count("$JS.API.STREAM.UPDATE.EPJ_space") === 0, allow);
check("the infrastructure principal gets no wildcard JetStream authority", !allow.some((entry) => entry.includes(">") || entry.includes("*")), allow);

// The restore-side login must carry an UPDATE row for every store the creation seam hardens, and
// core names those in one list: a store added to the hardening step without its grant broke the
// live restore at the listener-bind boundary ("Permissions Violation for Publish to
// $JS.API.STREAM.UPDATE.KV_cotal_issued_<space>"), which no unit of either side could see alone.
{
  const space = "scope";
  const hardened = hardenedAuthorityStreamNames(space);
  const live = infrastructureMaintenancePermissions("SCOPE_TEST", [...endpointPlaneStreamNames(space)], hardened);
  const liveAllow = ((live as { pub?: { allow?: string[] } }).pub?.allow ?? []);
  check("the hardened list names the records, issued, accepted and admission stores",
    hardened.length === 4 && hardened.every((s) => /^KV_cotal_(records|issued|accepted|admission)_scope$/.test(s)), hardened);
  check("the restore login carries exactly one UPDATE row per hardened store and none for any other endpoint stream",
    hardened.every((s) => liveAllow.filter((e) => e === `$JS.API.STREAM.UPDATE.${s}`).length === 1)
      && liveAllow.filter((e) => e.startsWith("$JS.API.STREAM.UPDATE.")).length === hardened.length, liveAllow.filter((e) => e.includes("UPDATE")));
}

let outside = "";
try {
  infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ_space"], ["KV_records_space"]);
} catch (error) {
  outside = (error as Error).message;
}
check("an update stream outside create/info scope is rejected", outside.includes("outside its create/info scope"), outside);

let invalid = "";
try {
  infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ.space"]);
} catch (error) {
  invalid = (error as Error).message;
}
check("an invalid maintenance stream name is rejected", invalid.includes("invalid maintenance stream name"), invalid);

// A listener that stays alive but never accepts connections must end at the 15 s boot bound, not
// at the operation deadline backup, restore and quarantine pass (30 minutes in the CLI).
{
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-isolated-boot-")));
  const pidFile = join(root, "fake.pid");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "nats-server"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "nats-server: v2.12.1"; exit 0; }\necho $$ > "${pidFile}"\nexec sleep 3600\n`);
  chmodSync(join(bin, "nats-server"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  const started = Date.now();
  let refused = "";
  try {
    const broker = await startIsolatedBroker({
      root,
      storeDir: join(root, "store"),
      space: "boot",
      mode: "open",
      deadline: new Date(started + 45_000),
      label: "backup",
      initialScope: { profile: "backup", scope: { operation: "inspect", selection: "full" } },
    });
    await broker.stop();
  } catch (error) {
    refused = (error as Error).message;
  } finally {
    process.env.PATH = path;
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped by the refusal */ }
    rmSync(root, { recursive: true, force: true });
  }
  const elapsed = Date.now() - started;
  check("an alive listener that never accepts is refused at the boot bound, before the operation deadline",
    refused.includes("did not become reachable") && elapsed < 30_000, { refused, elapsed });
}

console.log(`\nisolated infrastructure scope: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
