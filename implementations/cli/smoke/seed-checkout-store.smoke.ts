/**
 * A source-checkout CLI must not mutate the operator-global seed store (#1215).
 *
 * Drives `stageSeedPayload` / `gcSeedStore` in-process against an isolated
 * `XDG_CONFIG_HOME`. Never runs `pnpm cotal`. The store path is derived from
 * `XDG_CONFIG_HOME` only; `COTAL_HOME` is not a relocator and this suite asserts
 * that rather than assuming it.
 *
 * Run: pnpm smoke:seed-checkout-store
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeStamp } from "../src/seed/authority.js";
import { seedStoreDir, seedWriterKind } from "../src/seed/paths.js";
import { gcSeedStore, stageSeedPayload } from "../src/seed/store.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

const cleanup: string[] = [];
const track = (p: string): string => (cleanup.push(p), p);
const realArgv1 = process.argv[1];
const realXdg = process.env.XDG_CONFIG_HOME;
const realHome = process.env.COTAL_HOME;
const realAllow = process.env.COTAL_ALLOW_CHECKOUT_SEED;

function restoreEnv(): void {
  process.argv[1] = realArgv1;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  if (realHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = realHome;
  if (realAllow === undefined) delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
  else process.env.COTAL_ALLOW_CHECKOUT_SEED = realAllow;
}

function checkoutEntry(): string {
  const root = track(mkdtempSync(join(tmpdir(), "cotal-seed-checkout-")));
  mkdirSync(join(root, "implementations"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const entry = join(root, "bin", "cotal.ts");
  writeJson(join(root, "bin", "package.json"), { name: "cotal-ai", version: "0.99.0" });
  writeFileSync(entry, "export {}\n");
  return entry;
}

function installedEntry(): string {
  const root = track(mkdtempSync(join(tmpdir(), "cotal-seed-installed-")));
  const entry = join(root, "cotal-ai", "dist", "cotal.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeJson(join(root, "cotal-ai", "package.json"), { name: "cotal-ai", version: "0.42.0" });
  writeFileSync(entry, "export {}\n");
  return entry;
}

function unknownEntry(): string {
  const root = track(mkdtempSync(join(tmpdir(), "cotal-seed-unknown-")));
  const entry = join(root, "mystery", "runner.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "export {}\n");
  return entry;
}

function sandboxXdg(): string {
  const xdg = track(mkdtempSync(join(tmpdir(), "cotal-seed-xdg-")));
  process.env.XDG_CONFIG_HOME = xdg;
  return xdg;
}

function threw(fn: () => void): { ok: boolean; message: string } {
  try {
    fn();
    return { ok: false, message: "" };
  } catch (e) {
    return { ok: true, message: (e as Error).message };
  }
}

try {
  {
    const xdg = sandboxXdg();
    const cotalHome = track(mkdtempSync(join(tmpdir(), "cotal-home-not-seed-")));
    process.env.COTAL_HOME = cotalHome;
    const store = seedStoreDir();
    check(
      "seed store path follows XDG_CONFIG_HOME, not COTAL_HOME",
      store.startsWith(join(xdg, "cotal", "seed", "store")) && !store.startsWith(cotalHome),
      store,
    );
  }

  {
    process.argv[1] = checkoutEntry();
    check("classification: a repo-shaped bin/cotal-ai is a checkout", seedWriterKind() === "checkout");
    process.argv[1] = installedEntry();
    check("classification: a published cotal-ai package root is released", seedWriterKind() === "released");
    process.argv[1] = unknownEntry();
    check("classification: an unproven entry is unknown, not released", seedWriterKind() === "unknown");
    const npxRoot = track(mkdtempSync(join(tmpdir(), "cotal-seed-npx-")));
    const npxEntry = join(npxRoot, "_npx", "deadbeef", "node_modules", "cotal-ai", "dist", "cotal.js");
    mkdirSync(dirname(npxEntry), { recursive: true });
    writeJson(join(npxRoot, "_npx", "deadbeef", "node_modules", "cotal-ai", "package.json"), {
      name: "cotal-ai",
      version: "0.42.0",
    });
    writeFileSync(npxEntry, "export {}\n");
    process.argv[1] = npxEntry;
    check("classification: an npx unpack is released", seedWriterKind() === "released");
    const binOnly = track(mkdtempSync(join(tmpdir(), "cotal-seed-binonly-")));
    const binEntry = join(binOnly, "bin", "cotal.js");
    writeJson(join(binOnly, "bin", "package.json"), { name: "cotal-ai", version: "0.42.0" });
    writeFileSync(binEntry, "export {}\n");
    process.argv[1] = binEntry;
    check(
      "classification: a cotal-ai bin root without checkout markers is unknown, not released",
      seedWriterKind() === "unknown",
    );
  }

  {
    process.argv[1] = checkoutEntry();
    const xdg = sandboxXdg();
    delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
    const generation = "0.99.0";
    const dest = join(xdg, "cotal", "seed", "store", generation, "opencode");
    const result = threw(() => stageSeedPayload(generation, "opencode"));
    check(
      "checkout: staging an operator-global seed payload is refused",
      result.ok,
      result.message || "stageSeedPayload returned without throwing",
    );
    check(
      "checkout: the refusal names the store path, the declined generation, and the isolation remedy",
      result.ok &&
        result.message.includes(join(xdg, "cotal", "seed", "store")) &&
        result.message.includes(generation) &&
        result.message.includes("XDG_CONFIG_HOME") &&
        result.message.includes("COTAL_HOME"),
      result.message,
    );
    check(
      "checkout: the refusal does not advertise COTAL_ALLOW_CHECKOUT_SEED",
      result.ok && !result.message.includes("COTAL_ALLOW_CHECKOUT_SEED"),
      result.message,
    );
    check(
      "checkout: staging writes no payload under the sandboxed store",
      !existsSync(dest),
      dest,
    );
  }

  {
    process.argv[1] = checkoutEntry();
    const xdg = sandboxXdg();
    delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
    const stale = join(xdg, "cotal", "seed", "store", "0.38.0", "opencode");
    mkdirSync(stale, { recursive: true });
    writeJson(join(stale, "package.json"), { name: "@cotal-ai/connector-opencode", version: "0.38.0" });
    const result = threw(() => gcSeedStore("0.99.0", []));
    check(
      "checkout: GC of an unreferenced operator-global generation is refused",
      result.ok,
      result.message || "gcSeedStore returned without throwing",
    );
    check(
      "checkout: GC refusal names the store path, the declined generation, and the isolation remedy",
      result.ok &&
        result.message.includes(join(xdg, "cotal", "seed", "store")) &&
        result.message.includes("0.99.0") &&
        result.message.includes("XDG_CONFIG_HOME") &&
        result.message.includes("COTAL_HOME"),
      result.message,
    );
    check(
      "checkout: GC refusal does not advertise COTAL_ALLOW_CHECKOUT_SEED",
      result.ok && !result.message.includes("COTAL_ALLOW_CHECKOUT_SEED"),
      result.message,
    );
    check(
      "checkout: the installed generation is still on disk after the refusal",
      existsSync(join(stale, "package.json")),
      stale,
    );
  }

  {
    process.argv[1] = unknownEntry();
    const xdg = sandboxXdg();
    delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
    const dest = join(xdg, "cotal", "seed", "store", "0.99.0", "opencode");
    const result = threw(() => stageSeedPayload("0.99.0", "opencode"));
    check(
      "unknown identity: staging is refused rather than treated as a released install",
      result.ok,
      result.message || "stageSeedPayload returned without throwing",
    );
    check("unknown identity: staging writes no payload", !existsSync(dest), dest);
  }

  {
    process.argv[1] = checkoutEntry();
    const xdg = sandboxXdg();
    delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
    const dest = join(xdg, "cotal", "seed", "store", "0.99.0", "opencode");
    const result = threw(() => stageSeedPayload("0.99.0", "opencode", { force: true }));
    check(
      "checkout --force still refuses: force is not the opt-in",
      result.ok && !existsSync(dest),
      result.message || dest,
    );
  }

  {
    process.argv[1] = checkoutEntry();
    const xdg = sandboxXdg();
    process.env.COTAL_ALLOW_CHECKOUT_SEED = "0";
    const dest = join(xdg, "cotal", "seed", "store", "0.99.0", "opencode");
    const result = threw(() => stageSeedPayload("0.99.0", "opencode"));
    check(
      "checkout: a non-1 COTAL_ALLOW_CHECKOUT_SEED is not an opt-in",
      result.ok && !existsSync(dest),
      result.message || dest,
    );
  }

  {
    process.argv[1] = installedEntry();
    const xdg = sandboxXdg();
    delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
    const generation = "0.42.0";
    const dest = stageSeedPayload(generation, "opencode");
    check(
      "released install: staging still writes the sandboxed payload",
      existsSync(join(dest, "package.json")) && dest.startsWith(join(xdg, "cotal", "seed", "store", generation)),
      dest,
    );
  }

  {
    process.argv[1] = checkoutEntry();
    const xdg = sandboxXdg();
    process.env.COTAL_ALLOW_CHECKOUT_SEED = "1";
    const generation = "0.99.0";
    const dest = stageSeedPayload(generation, "opencode");
    check(
      "opt-in: COTAL_ALLOW_CHECKOUT_SEED=1 lets a checkout write a sandboxed payload",
      existsSync(join(dest, "package.json")) && dest.startsWith(join(xdg, "cotal", "seed", "store", generation)),
      dest,
    );
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as { name?: string };
    check("opt-in: the staged payload is a real shipped connector", pkg.name === "@cotal-ai/connector-opencode", pkg);
    const stamp = writeStamp(generation, process.argv[1]!);
    check(
      "opt-in: the stamp still names the checkout entry that wrote it",
      stamp.writtenBy === process.argv[1] && stamp.generation === generation,
      stamp,
    );
  }
} finally {
  restoreEnv();
  for (const p of cleanup) rmSync(p, { recursive: true, force: true });
}

console.log(`\nseed-checkout-store smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
