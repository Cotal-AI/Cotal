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
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:dry-run-no-seed` does
 * that first. Run: pnpm smoke:dry-run-no-seed
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

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
function cotal(args: string[]): { status: number; stdout: string; stderr: string } {
  const cfg = mkdtempSync(join(tmpdir(), "cotal-dryrun-noseed-"));
  cleanup.push(cfg);
  const r = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
  });
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

// ── 2. a VALID dry run plans and prints while writing nothing ─────────────────────────────────────
{
  const r = cotal(["down", "--dry-run"]);
  const out = `${r.stdout}${r.stderr}`;
  check("a valid dry run succeeds", r.status === 0, { status: r.status, out: out.slice(0, 400) });
  check("a valid dry run still renders its plan", /Dry run - nothing was changed/.test(out), out.slice(0, 400));
}

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
finish(); // emits the cell-count sentinel and sets a non-zero exit code on any failed cell
