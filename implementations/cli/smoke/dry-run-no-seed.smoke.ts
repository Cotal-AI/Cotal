/**
 * #1620 — a dry run must mutate NOTHING, including the operator-global seed store.
 *
 * `runCli` ran the connector-seeding boot gate BEFORE command lookup, flag parsing and the command
 * body, so a newer staged binary invoked as `cotal down --preserve-state --dry-run` against a live
 * older deployment rewrote the machine-wide seed store, manifest and npm prefix to the new version
 * and only THEN printed the usage refusal for the unsupported flag combination. No service stopped,
 * yet the operator's next command from the older CLI failed on version skew.
 *
 * Both halves are load-bearing and both run against the BUILT binary with an isolated
 * XDG_CONFIG_HOME, so nothing here touches the developer's real store:
 *   1. the exact incident invocation — an invalid `--dry-run` combination — refuses AND leaves the
 *      config dir untouched (no seed store, no manifest, no npm prefix);
 *   2. a VALID dry run (`down --dry-run`) plans, prints and exits 0 while writing nothing, so the
 *      guard is about dry runs rather than about this one usage error.
 *
 * Exits non-zero the moment a dry run writes, so the defect cannot ride green through CI.
 * Every `down` call is anchored to a throwaway sandbox root/COTAL_HOME/XDG_CONFIG_HOME and passed
 * through the shared `assertSmokeSandboxDown` guard, so a dry run here can never resolve the
 * developer's real mesh (without COTAL_HOME it walks upward and finds the live one).
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:dry-run-no-seed` does
 * that first. Run: pnpm smoke:dry-run-no-seed
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();

// The harness may itself run inside a supervised seat whose env carries COTAL_* state —
// COTAL_SKIP_CONNECTOR_SEED in particular suppresses the very auto-seed under test, which would
// make this smoke pass for the wrong reason. Scrub them, then opt the checkout in deliberately.
const HOST_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")),
);
const cleanup: string[] = [];
// Registered BEFORE the first cell, because the sandbox guard THROWS rather than returning a failed
// cell: a trailing `for (…) rmSync(…)` is skipped exactly when a run goes wrong, which in CI is every
// run where this suite is doing its job. `process.on("exit")` fires on a normal finish and on an
// uncaught throw alike, and rmSync is synchronous, so it is safe in an exit handler.
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});
function cotal(args: string[]): { status: number; stdout: string; stderr: string } {
  // A fresh sandbox per invocation: the assertion below is "this config dir is still empty", which
  // only means anything if nothing else could have written it. The sandbox also pins COTAL_HOME, so
  // `down` reads this throwaway mesh registry instead of walking up into the real one.
  const sandboxRoot = mkdtempSync(join(tmpdir(), "cotal-dryrun-noseed-root-"));
  const cfg = mkdtempSync(join(tmpdir(), "cotal-dryrun-noseed-"));
  const cotalHome = join(sandboxRoot, "home");
  cleanup.push(sandboxRoot, cfg);
  const sandbox = recordSmokeSandbox({ root: sandboxRoot, cotalHome, xdgConfigHome: cfg });
  const options = {
    cwd: sandboxRoot,
    env: { ...HOST_ENV, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
    encoding: "utf8" as const,
  };
  // Refuses the spawn outright if these args would tear down anything but this sandbox.
  assertSmokeSandboxDown(sandbox, args, options);
  const r = spawnSync("node", [BIN, ...args], options);
  // The whole point is "wrote nothing", so assert the DIRECTORY, not a chosen file: any entry the
  // run created under `<config>/cotal` is a mutation the dry run promised not to make.
  const root = join(cfg, "cotal");
  const wrote = existsSync(root) ? readdirSync(root).sort() : [];
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(
    `\`cotal ${args.join(" ")}\`: no operator-global state written`,
    wrote.length === 0,
    { created: wrote, output: out.slice(0, 400) },
  );
  check(
    `\`cotal ${args.join(" ")}\`: announces no seed-store write`,
    !out.includes("seed store payload"),
    out.slice(0, 400),
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── 1. the incident invocation: an invalid combination refuses, having mutated nothing ────────────
{
  const r = cotal(["down", "--preserve-state", "--dry-run"]);
  const out = `${r.stdout}${r.stderr}`;
  check("invalid dry-run combination is still refused", r.status === 1, { status: r.status, out: out.slice(0, 400) });
  check(
    "the refusal is the usage error, not a seed failure",
    /--preserve-state is bare-whole-stack only/.test(out),
    out.slice(0, 400),
  );
}

// ── 2. a VALID dry run reaches the command body while writing nothing ─────────────────────────────
// In an isolated sandbox there is no stack to stop, so `down --dry-run` reports exactly that. That
// is still the cell that matters here: reaching the command body at all proves the boot gate was
// skipped for a well-formed dry run too, not merely for the one that fails validation. The writes
// are asserted by the shared `cotal()` helper above.
{
  const r = cotal(["down", "--dry-run"]);
  const out = `${r.stdout}${r.stderr}`;
  check(
    "a valid dry run reaches the command body",
    /Nothing running for the local stack|Dry run - nothing was changed/.test(out),
    { status: r.status, out: out.slice(0, 400) },
  );
  check(
    "a valid dry run never reports a seed or usage failure",
    !/seed store payload|bare-whole-stack only/.test(out),
    out.slice(0, 400),
  );
}

finish(); // emits the cell-count sentinel and sets a non-zero exit code on any failed cell
