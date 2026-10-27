/**
 * Linear account refusals, with no upstream and no broker. `linear account show` for a name with no
 * record and a Linear service whose account has no record both refuse with TARGET_NOT_FOUND and the
 * account-add route. The service refusal comes from its launch plan, so no child is ever started. A
 * record that exists but cannot be read stays DEPENDENCY_UNAVAILABLE, and a recorded account still
 * produces a launch plan. A definition whose envRefs set the variable the Cotal home falls back to
 * (HOME on POSIX, LOCALAPPDATA on Windows) refuses before any account read while COTAL_HOME is unset,
 * because the child would read its account under that home; with COTAL_HOME set the child inherits
 * it, and the same definition plans.
 *
 * The grammar refuses a flag an operation does not take by naming it and the flags the operation
 * does take: `serve --json` says serve is a foreground service with no --json or --plain output,
 * and `account login --json` names --plain as its only output flag. Each operation's help shows
 * its own one-line usage, and the command's usage lists those forms one per line.
 *
 * Run: pnpm smoke:linear-accounts   (needs `pnpm build` of core and workspace first)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every account and registry file this run touches lives under a throwaway home.
const home = mkdtempSync(join(tmpdir(), "linear-accounts-smoke-"));
process.env.COTAL_HOME = join(home, "cotal");
process.env.HOME = home;
const { homeCotalDirFallbacks, isCommandFailure, recordMesh } = await import("@cotal-ai/workspace");
const { linearDir, saveAccount, storedTokenPath } = await import("../src/account.js");
const { accountForRead, validateLinearArguments } = await import("../src/cli.js");
const { linearService } = await import("../src/service-adapter.js");
const { registry } = await import("@cotal-ai/core");
await import("../src/index.js");

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
/** The refusal a call throws or rejects with, as code and remedy, or undefined when it returns. */
const refusal = async (fn: () => unknown) => {
  try { await fn(); return undefined; }
  catch (error) { return isCommandFailure(error) ? { code: error.code, message: error.message, remedy: error.remedy } : { code: "thrown", message: String(error), remedy: undefined }; }
};

try {
  const grammar = (positionals: string[], values: Record<string, string | boolean>) => refusal(() => validateLinearArguments({ positionals, values, raw: [] }));
  const serveJson = await grammar(["serve", "work"], { endpoint: "com.example.linear", json: true });
  check("serve --json is a usage refusal naming the flag and the operation", serveJson?.code === "USAGE_INVALID" && serveJson.message.startsWith("--json does not belong to linear serve"), serveJson);
  check("...that says serve has no --json or --plain output", serveJson?.message.includes("foreground service that reports as text and has no --json or --plain output") === true, serveJson);
  check("...and names the flags serve takes with its usage", serveJson?.remedy === "drop --json; linear serve takes --endpoint, --space, --server: cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]", serveJson);
  const loginJson = await grammar(["account", "login", "work"], { mode: "readonly", json: true });
  check("account login --json names --plain as its only output flag", loginJson?.code === "USAGE_INVALID" && loginJson.message.includes("linear account login, whose only output flag is --plain"), loginJson);
  const serveTimeout = await grammar(["serve", "work"], { endpoint: "com.example.linear", timeout: "5" });
  check("a non-format foreign flag is named without an output reason", serveTimeout?.code === "USAGE_INVALID" && serveTimeout.message === "--timeout does not belong to linear serve; no account or request was opened", serveTimeout);
  const serveAccepted = await grammar(["serve", "work"], { endpoint: "com.example.linear", space: "s", server: "nats://127.0.0.1:4222" });
  check("serve with only its own flags passes the grammar", serveAccepted === undefined, serveAccepted);
  const callerJson = await grammar(["caller", "seat"], { endpoint: "com.example.linear", out: "/tmp/caller.creds", json: true });
  check("caller still takes --json", callerJson === undefined, callerJson);

  const command = registry.resolve<import("@cotal-ai/core").Command>("command", "linear");
  const leaves = (command.subcommands ?? []).flatMap((sub) => sub.subcommands?.length ? sub.subcommands : [sub]);
  const usages = leaves.map((leaf) => leaf.usage ?? "");
  check("each of the 9 operations has a one-line usage, and the command's usage is those forms one per line", leaves.length === 9 && usages.every((usage) => usage.startsWith("cotal linear ") && !usage.includes("\n")) && command.usage === usages.join("\n"), { usages, command: command.usage });
  const serveSub = command.subcommands?.find((sub) => sub.name === "serve");
  check("serve's help usage is its own form", serveSub?.usage === "cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]", serveSub?.usage);

  const missing = await refusal(() => accountForRead("nosuch"));
  check("an account with no record is TARGET_NOT_FOUND", missing?.code === "TARGET_NOT_FOUND", missing);
  check("...with the route that records it", missing?.remedy?.includes("cotal linear account add nosuch") === true, missing);

  mkdirSync(linearDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(linearDir(), "broken.json"), "not json\n", { mode: 0o600 });
  const unreadable = await refusal(() => accountForRead("broken"));
  check("a record that exists but cannot be read stays DEPENDENCY_UNAVAILABLE", unreadable?.code === "DEPENDENCY_UNAVAILABLE", unreadable);

  // A registered static-auth target, so the plan reaches its account check offline.
  const SPACE = "linearaccounts";
  const root = mkdtempSync(join(tmpdir(), "linear-accounts-root-"));
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  recordMesh({ space: SPACE, server: "nats://127.0.0.1:4222", root, mode: "auth", ts: new Date().toISOString() });
  const stateDirectory = mkdtempSync(join(tmpdir(), "linear-accounts-state-"));
  const context = (account: string, envRefs?: Record<string, string>) => ({
    space: SPACE, definition: "lin", definitionRevision: "1", instanceId: randomUUID(), launchRequestId: randomUUID(), stateDirectory,
    cliInvocation: [process.execPath, "/cotal.js"], options: { root, account, endpoint: "com.example.linear" }, ...(envRefs ? { envRefs } : {}),
  });
  const start = await refusal(() => linearService.buildServiceLaunch!(context("nosuch")));
  check("a service whose account has no record refuses in its launch plan", start?.code === "TARGET_NOT_FOUND" && start.remedy?.includes("cotal linear account add nosuch") === true, start);

  saveAccount({ name: "present", mode: "readonly", auth: "token", tokenFile: storedTokenPath("present") }, "local-token");
  let plan: unknown;
  const recorded = await refusal(async () => { plan = await linearService.buildServiceLaunch!(context("present")); });
  const args = (plan as { args?: readonly string[] } | undefined)?.args ?? [];
  check("a recorded account still produces the native child's launch plan", recorded === undefined && args.includes("__service-linear") && args[args.indexOf("--account") + 1] === "present", recorded ?? args);

  // The variable the Cotal home falls back to here: HOME on POSIX, LOCALAPPDATA on Windows.
  const fallback = homeCotalDirFallbacks()[0]!;
  // The child inherits COTAL_HOME, so a reference to that variable cannot move its Cotal home while it is set.
  const pinned = await refusal(() => linearService.buildServiceLaunch!(context("present", { [fallback]: "SERVICE_HOME" })));
  check(`with COTAL_HOME set, a ${fallback} reference still plans with the recorded account`, pinned === undefined, pinned);
  // Without COTAL_HOME the child's Cotal home follows its own copy of that variable, which this process cannot read for it.
  const cotalHome = process.env.COTAL_HOME;
  delete process.env.COTAL_HOME;
  try {
    for (const account of ["present", "nosuch"]) {
      const moved = await refusal(() => linearService.buildServiceLaunch!(context(account, { [fallback]: "SERVICE_HOME" })));
      check(`without COTAL_HOME, a ${fallback} reference refuses before reading account "${account}"`, moved?.code === "UNSUPPORTED" && moved.message.includes(`envRefs set ${fallback}`) && moved.remedy?.includes("COTAL_HOME") === true, moved);
    }
  } finally { process.env.COTAL_HOME = cotalHome; }
  for (const dir of [root, stateDirectory]) rmSync(dir, { recursive: true, force: true });
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
