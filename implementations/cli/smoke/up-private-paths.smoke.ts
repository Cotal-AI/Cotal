/**
 * `cotal up` creates the paths its own protection checks later read owner-private, even under a
 * group-writable umask (0002). No broker is started.
 *
 * SCOPE, stated honestly: under umask 0002 this runs `prepareBrokerStart`, the broker preparation the
 * controller stack and `up --detach` share, for a static-auth root that `space create` prepared and
 * for a bare open root. It reads the modes that preparation left on `.cotal`, the broker store, the
 * auth directory and the broker configuration, and runs the broker preset's own path check over the
 * root and configuration it would launch. It then makes the configuration and `.cotal`
 * world-writable and checks that each refusal names the option, the path and its mode, that a later
 * preparation tightens the configuration again, that a re-prepare refuses a symlink planted at
 * server.conf and leaves its target alone, and that the text failure report prints a wrapped
 * cause's detail on one line. It also opens the detached broker log through `openBrokerLog`, the
 * open `up --detach` uses, and checks that it creates the log 0600, sets an owned group-writable log
 * to 0600, refuses a symlink without changing its target, and never creates a symlink's target. A log
 * another user owns needs a second uid and is not covered. Section 5 narrows a ports report written
 * under umask 0002 with the broker readiness helper and checks it refuses a symlink; it does not run
 * nats-server or the readiness check itself. Section 6 opens the manager log path through the open
 * `startManagerDetached` uses and checks a symlink there refuses; it does not start a manager, because
 * that function's selfArgv guard refuses a smoke first. Section 7 refuses a symlink at the
 * delivery-aware marker (through the same write, not a manager start) and at a pid identity pin
 * (through writeIdentityPin), and checks writePidPair publishes 0600 records. The foreground `up` store
 * (up.ts:1434), the manifest user-auth pre-resolve (up.ts:2567) and the nested-folder `.cotal`
 * (up.ts:3181) are NOT driven, and nothing here launches a broker. Needs `nats-server` on PATH, since
 * preparation resolves it.
 *
 * Run: pnpm smoke:up-private-paths
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";

// The scratch base and the machine home are fixed before anything that resolves a root is imported.
const scratch = makeScratch("cotal-up-private-paths-");
process.env.COTAL_HOME = mkdtempSync(join(scratch, "home-"));
const originalCwd = process.cwd();
const originalUmask = process.umask(0o002);

await import("../src/index.js");
const { CommandFailure, authDir, commandFailureReport, isCommandFailure, protectedLocalDirectory, renderReport, validateServiceAdapterPaths } = await import("@cotal-ai/workspace");
const { openBrokerLog, prepareBrokerStart } = await import("../src/commands/up.js");
const { recordLocalSpace } = await import("../src/commands/space-registration.js");
const { brokerService, narrowPortsReport } = await import("../src/lib/broker-service.js");
const { managerLogPath } = await import("../src/lib/manager-proc.js");
const { openPrivateAppend, writePrivateRecord } = await import("@cotal-ai/core");
const { MANAGER_DELIVERY_AWARE_MARKER, canonicalLocalProcessPath, identityPinPath, writeIdentityPin, writePidPair } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const mode = (path: string): number => lstatSync(path).mode & 0o777;
const octal = (bits: number): string => bits.toString(8).padStart(4, "0");
/** What the broker preset's own path check raises for these options, or undefined when it passes. */
const refusal = (options: Record<string, unknown>): unknown => {
  try {
    validateServiceAdapterPaths(brokerService.service!, options);
    return undefined;
  } catch (error) {
    return error;
  }
};
const prepare = async (space: string, open: boolean) =>
  prepareBrokerStart({ transport: { kind: "plaintext" }, server: `nats://127.0.0.1:${await freePort()}`, space, ...(open ? { open: true } : {}) });

try {
  assertScratchHeld(scratch);
  let scratchProtected = true;
  try { protectedLocalDirectory(scratch); } catch { scratchProtected = false; }
  check("the scratch directory's ancestry is protected, so a refusal below belongs to the product", scratchProtected, scratch);

  console.log("1. a static-auth root that space create prepared");
  {
    const root = mkdtempSync(join(scratch, "auth-"));
    process.chdir(root);
    recordLocalSpace("private-auth", root);
    const prepared = await prepare("private-auth", false);
    const control = join(prepared.root, ".cotal");
    check(".cotal stays 0700", mode(control) === 0o700, octal(mode(control)));
    check("the broker store is created 0700", mode(prepared.storeDir) === 0o700, octal(mode(prepared.storeDir)));
    check("the auth directory is 0700", mode(authDir(prepared.root)) === 0o700, octal(mode(authDir(prepared.root))));
    check("the broker configuration is server.conf, written 0600",
      prepared.confPath === join(authDir(prepared.root), "server.conf") && mode(prepared.confPath) === 0o600, { path: prepared.confPath, mode: octal(mode(prepared.confPath)) });
    check("the broker preset accepts the prepared root and configuration", refusal({ root: prepared.root, config: prepared.confPath }) === undefined, refusal({ root: prepared.root, config: prepared.confPath }));

    chmodSync(prepared.confPath, 0o666);
    const file = refusal({ root: prepared.root, config: prepared.confPath });
    check("a world-writable configuration refuses and names the option, the path and its mode",
      isCommandFailure(file) && file.code === "PERMISSION_DENIED" && file.message.includes("adapter path config ")
        && file.message.includes(`${prepared.confPath} is a file`) && file.message.includes("mode 0666"), file);
    await prepare("private-auth", false);
    check("a later preparation tightens the existing configuration to 0600", mode(prepared.confPath) === 0o600, octal(mode(prepared.confPath)));

    // A re-prepare never writes through a symlink planted at the configuration's name.
    const outside = join(scratch, "outside.conf");
    writeFileSync(outside, "not the broker's\n", { mode: 0o644 });
    chmodSync(outside, 0o644);
    rmSync(prepared.confPath);
    symlinkSync(outside, prepared.confPath);
    let planted: unknown;
    try { await prepare("private-auth", false); } catch (error) { planted = error; }
    check("a re-prepare refuses a symlink at server.conf", (planted as NodeJS.ErrnoException | undefined)?.code === "EPERM", planted);
    check("the symlink's target keeps its bytes and mode",
      readFileSync(outside, "utf8") === "not the broker's\n" && mode(outside) === 0o644, octal(mode(outside)));
    rmSync(prepared.confPath);
    await prepare("private-auth", false);
    check("with the symlink removed, preparation writes server.conf 0600 again", mode(prepared.confPath) === 0o600, octal(mode(prepared.confPath)));

    chmodSync(control, 0o777);
    const ancestor = refusal({ config: prepared.confPath });
    check("a world-writable .cotal refuses and names that directory instead of the configuration",
      isCommandFailure(ancestor) && ancestor.code === "PERMISSION_DENIED" && ancestor.message.includes(`${control} is a directory`)
        && ancestor.message.includes("mode 0777"), ancestor);
    chmodSync(control, 0o700);
  }

  console.log("2. a bare open root, where the store create also makes .cotal");
  {
    const root = mkdtempSync(join(scratch, "open-"));
    process.chdir(root);
    const prepared = await prepare("private-open", true);
    const control = join(prepared.root, ".cotal");
    check(".cotal made by the store create is 0700", mode(control) === 0o700, octal(mode(control)));
    check("the broker store is created 0700", mode(prepared.storeDir) === 0o700, octal(mode(prepared.storeDir)));
    check("the open configuration is written 0600", mode(prepared.confPath) === 0o600, octal(mode(prepared.confPath)));
    check("the broker preset accepts the prepared root and configuration", refusal({ root: prepared.root, config: prepared.confPath }) === undefined, refusal({ root: prepared.root, config: prepared.confPath }));
  }

  console.log("3. the text failure report prints a wrapped cause's detail on one line");
  {
    const detail = "the declared adapter path config is not protected\nagainst other local writers";
    const failure = new CommandFailure("refused", "PERMISSION_DENIED", "the controller stack did not start every planned member", { native: { code: "PERMISSION_DENIED", outcome: "refused", detail } });
    const text = renderReport(commandFailureReport(failure), "plain", 400);
    const line = text.split("\n").find((row) => row.includes("Native detail"));
    check("the detail is a report field", line?.includes("the declared adapter path config is not protected") === true, text);
    check("a newline inside the detail is escaped, so the field stays one line", line?.includes("against other local writers") === true, text);
  }

  console.log("4. the detached broker log opens owner-private and never through a symlink");
  {
    const control = mkdtempSync(join(scratch, "log-"));
    const log = join(control, "nats.log");
    const opened = (): unknown => {
      try { closeSync(openBrokerLog(log)); return undefined; } catch (error) { return error; }
    };
    check("a missing log is created and opened", opened() === undefined && existsSync(log));
    check("the created log is 0600 under umask 0002", mode(log) === 0o600, octal(mode(log)));
    check("an existing private log opens again", opened() === undefined && mode(log) === 0o600, octal(mode(log)));

    // An earlier build's log is this user's own file with a looser mode: it is narrowed, not refused.
    chmodSync(log, 0o664);
    check("an owned group-writable log opens and is set to 0600", opened() === undefined && mode(log) === 0o600, octal(mode(log)));
    rmSync(log);

    const target = join(control, "elsewhere");
    writeFileSync(target, "kept\n", { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, log);
    const linked = opened();
    check("a symlink at the log name refuses, naming the path", isCommandFailure(linked) && linked.code === "PERMISSION_DENIED" && linked.message.includes(log) && linked.message.includes("is a symlink"), linked);
    check("the symlink's target is neither written nor re-moded", readFileSync(target, "utf8") === "kept\n" && mode(target) === 0o644, octal(mode(target)));
    rmSync(log);
    rmSync(target);

    symlinkSync(target, log);
    const dangling = opened();
    check("a symlink to a missing file refuses and creates nothing", isCommandFailure(dangling) && !existsSync(target), dangling);
  }

  console.log("5. the broker's ports report is narrowed to 0600 when readiness reads it");
  {
    // nats-server writes its report under the umask it inherited; this writes one the same way.
    const ports = mkdtempSync(join(scratch, "ports-"));
    const report = join(ports, "nats-server_1.ports");
    writeFileSync(report, "{\"nats\":[\"nats://127.0.0.1:4222\"]}\n");
    check("a report written under umask 0002 starts 0664", mode(report) === 0o664, octal(mode(report)));
    narrowPortsReport(report);
    check("the readiness narrowing sets it to 0600 and keeps its bytes",
      mode(report) === 0o600 && readFileSync(report, "utf8") === "{\"nats\":[\"nats://127.0.0.1:4222\"]}\n", octal(mode(report)));

    const outside = join(scratch, "outside.ports");
    writeFileSync(outside, "kept\n", { mode: 0o644 });
    chmodSync(outside, 0o644);
    const linked = join(ports, "nats-server_2.ports");
    symlinkSync(outside, linked);
    let refused: unknown;
    try { narrowPortsReport(linked); } catch (error) { refused = error; }
    check("a symlink at the report name refuses and is not followed",
      isCommandFailure(refused) && refused.code === "OPERATION_UNKNOWN" && mode(outside) === 0o644 && readFileSync(outside, "utf8") === "kept\n", refused);
    check("...and the refusal names the report's path",
      isCommandFailure(refused) && (refused.target as { path?: string } | null)?.path === linked, isCommandFailure(refused) ? refused.target : refused);
  }

  console.log("6. the manager log, which carries the console URL, opens owner-private and never through a symlink");
  {
    // startManagerDetached opens managerLogPath with openPrivateAppend. Its selfArgv guard refuses a
    // smoke before that open, so this drives the same open at the same path without starting a manager.
    const root = mkdtempSync(join(scratch, "manager-"));
    mkdirSync(join(root, ".cotal"), { mode: 0o700 });
    const log = managerLogPath("private-manager", root);
    const outside = join(scratch, "outside-manager.log");
    writeFileSync(outside, "not the manager's\n", { mode: 0o644 });
    chmodSync(outside, 0o644);
    symlinkSync(outside, log);
    let linked: unknown;
    try { closeSync(openPrivateAppend(log)); } catch (error) { linked = error; }
    check("a symlink at the manager log refuses with EPERM", (linked as NodeJS.ErrnoException | undefined)?.code === "EPERM", linked);
    check("the symlink's target is neither re-moded nor written",
      mode(outside) === 0o644 && readFileSync(outside, "utf8") === "not the manager's\n", octal(mode(outside)));
    rmSync(log);

    writeFileSync(log, "an earlier version's log\n", { mode: 0o644 });
    chmodSync(log, 0o644);
    closeSync(openPrivateAppend(log));
    check("an earlier version's 0644 manager log is set to 0600 and kept",
      mode(log) === 0o600 && readFileSync(log, "utf8") === "an earlier version's log\n", octal(mode(log)));
  }

  console.log("7. process records: the marker and the identity pin never write through a symlink, and pid pairs are 0600");
  {
    const root = mkdtempSync(join(scratch, "records-"));
    mkdirSync(join(root, ".cotal"), { mode: 0o700 });
    const outside = join(scratch, "outside-record");
    writeFileSync(outside, "someone else's\n", { mode: 0o644 });
    chmodSync(outside, 0o644);
    const untouched = () => mode(outside) === 0o644 && readFileSync(outside, "utf8") === "someone else's\n";
    const codeOf = (act: () => void): string | undefined => {
      try { act(); return undefined; } catch (error) { return (error as NodeJS.ErrnoException).code; }
    };

    // startManagerDetached writes the marker with writePrivateRecord after it spawns; the same write
    // at the same path runs here without a manager.
    const marker = canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, { root, space: "private-records" });
    symlinkSync(outside, marker);
    check("a symlink at the delivery-aware marker refuses with EPERM", codeOf(() => writePrivateRecord(marker, "1234")) === "EPERM");
    check("the marker symlink's target is left unchanged", untouched(), octal(mode(outside)));

    const pidfile = join(root, ".cotal", "web.pid");
    symlinkSync(outside, identityPinPath(pidfile));
    check("writeIdentityPin refuses a symlink at the pin with EPERM", codeOf(() => writeIdentityPin(pidfile, process.pid)) === "EPERM");
    check("the pin symlink's target is left unchanged", untouched(), octal(mode(outside)));
    rmSync(identityPinPath(pidfile));

    const paired = join(root, ".cotal", "nats.pid");
    writePidPair(paired, process.pid);
    check("writePidPair publishes the pidfile 0600 under umask 0002", mode(paired) === 0o600, octal(mode(paired)));
    check("...and its identity pin 0600", mode(identityPinPath(paired)) === 0o600, octal(mode(identityPinPath(paired))));
    check("...and leaves no temporary behind", readdirSync(join(root, ".cotal")).every((name) => !name.includes(".publish.")), readdirSync(join(root, ".cotal")));
  }
} finally {
  process.chdir(originalCwd);
  process.umask(originalUmask);
  rmSync(scratch, { recursive: true, force: true });
}
finish();
