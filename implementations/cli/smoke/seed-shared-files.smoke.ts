/**
 * A published `cotal-ai` ships the docs data every connector bundle reads (`docs-bundle.bin`,
 * `docs-index.bin`) once, in `seeded-connectors/_shared/`, with a `placements.json` naming every path
 * the prepack removed it from. `sharedPlacements` is the one reader of that manifest: the seed store
 * restores each placement from it and `cotal update` compares each installed copy with it. These cells
 * drive it over a published layout written here, including read-only payload staging and repair,
 * then over each way the manifest or a shared file can be wrong. Requires the CLI built. The packed
 * tarball, the restored install and the verify are proven end to end by
 * `smoke:seed-tarball:live`.
 * Broker-free, no network. Run: pnpm smoke:seed-shared-files
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { sharedPlacements } from "../src/seed/shared.js";

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
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

function refusal(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const base = mkdtempSync(join(tmpdir(), "cotal-seed-shared-"));
try {
  // A source checkout's payload holds its own docs files and is not under `seeded-connectors/`.
  const devPayload = join(base, "extensions", "connector-claude-code");
  mkdirSync(devPayload, { recursive: true });
  check("a checkout payload has no shared placements", sharedPlacements("claude", devPayload).length === 0);

  const root = join(base, "cotal-ai", "seeded-connectors");
  const shared = join(root, "_shared");
  const payload = join(root, "claude");
  mkdirSync(shared, { recursive: true });
  mkdirSync(payload, { recursive: true });
  const bundle = "docs corpus bytes";
  const index = "docs index bytes";
  const files = { "docs-bundle.bin": sha256(bundle), "docs-index.bin": sha256(index) };
  writeFileSync(join(shared, "docs-bundle.bin"), bundle);
  writeFileSync(join(shared, "docs-index.bin"), index);
  const manifest = (placements: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    writeFileSync(join(shared, "placements.json"), JSON.stringify({ v: 1, files, placements, ...extra }));

  manifest({ claude: ["dist/docs-bundle.bin", "dist/docs-index.bin", "dist/server/docs-bundle.bin"], web: ["dist/docs-index.bin"] });
  const placed = sharedPlacements("claude", payload);
  check("a published payload gets every path the manifest lists for it", placed.length === 3, placed);
  check(
    "each placement keeps its path and names the one shipped copy",
    placed.map((p) => `${p.rel}=${p.source}`).join(" ") ===
      [`dist/docs-bundle.bin=${join(shared, "docs-bundle.bin")}`, `dist/docs-index.bin=${join(shared, "docs-index.bin")}`, `dist/server/docs-bundle.bin=${join(shared, "docs-bundle.bin")}`].join(" "),
    placed,
  );
  check("a built-in the manifest does not list gets none", sharedPlacements("codex", join(root, "codex")).length === 0);

  // Load the compiled seeder outside the checkout so it resolves this published payload.
  const implementation = join(base, "implementation");
  cpSync(join(import.meta.dirname, "..", "dist", "seed"), join(implementation, "dist", "seed"), { recursive: true });
  cpSync(join(import.meta.dirname, "..", "package.json"), join(implementation, "package.json"));
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(implementation, "node_modules"), "junction");
  const entry = join(base, "cotal-ai", "dist", "cotal.js");
  mkdirSync(join(payload, "dist"), { recursive: true });
  mkdirSync(join(base, "cotal-ai", "dist"), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(join(base, "cotal-ai", "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.42.0" }));
  writeFileSync(join(payload, "package.json"), JSON.stringify({ name: "@cotal-ai/connector-claude-code", version: "0.42.0" }));
  writeFileSync(join(payload, "dist", "launch.js"), "// executable payload\n", { mode: 0o755 });
  const modes = (path: string, writable: boolean): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, writable ? 0o755 : 0o555);
      for (const name of readdirSync(path)) modes(join(path, name), writable);
    } else chmodSync(path, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
  };
  const config = join(base, "config");
  const dest = join(config, "cotal", "seed", "store", "0.42.0", "claude");
  const stage = (force = false) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.argv[1] = ${JSON.stringify(entry)};
    const { stageSeedPayload } = await import(${JSON.stringify(pathToFileURL(join(implementation, "dist", "seed", "store.js")).href)});
    stageSeedPayload("0.42.0", "claude", { force: ${force} });
  `], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    modes(payload, false);
    const first = stage();
    check("read-only published payload seeds successfully", first.status === 0, first.stderr);
    if (first.status === 0) {
      check("shared docs are restored at every placement", placed.every(({ rel, source }) => readFileSync(join(dest, rel)).equals(readFileSync(source))));
      check("staging keeps executable bits and leaves shipped modes unchanged", process.platform === "win32" || ((statSync(join(dest, "dist", "launch.js")).mode & 0o111) === 0o111 && (statSync(join(payload, "dist")).mode & 0o222) === 0));
      cpSync(payload, `${dest}.staging`, { recursive: true });
      modes(dest, false);
      const repaired = stage(true);
      check("repair replaces read-only stale staging and prior store directories", repaired.status === 0 && !existsSync(`${dest}.staging`), repaired.stderr);
    }
  } finally {
    modes(payload, true);
    if (existsSync(config)) modes(config, true);
  }

  const refusals: [string, () => void, string][] = [
    ["a missing manifest", () => rmSync(join(shared, "placements.json")), "is unreadable"],
    ["a manifest of another version", () => manifest({ claude: [] }, { v: 2 }), "is not a version 1 manifest"],
    ["a manifest with no file digests", () => manifest({ claude: [] }, { files: undefined }), "is not a version 1 manifest"],
    ["paths that are not a list", () => manifest({ claude: "dist/docs-bundle.bin" }), "lists no paths for claude"],
    ["a path climbing out of the payload", () => manifest({ claude: ["../web/docs-bundle.bin"] }), "outside the claude payload"],
    ["an absolute path", () => manifest({ claude: [join(base, "docs-bundle.bin")] }), "outside the claude payload"],
    ["a path that is not normalized", () => manifest({ claude: ["dist//docs-bundle.bin"] }), "outside the claude payload"],
    ["a path that is not a string", () => manifest({ claude: [7] }), "outside the claude payload"],
    ["a file that is not shared", () => manifest({ claude: ["dist/index.js"] }), "which is not a shared file"],
    ["a shipped copy that is not the recorded bytes", () => (manifest({ claude: ["dist/docs-bundle.bin"] }), writeFileSync(join(shared, "docs-bundle.bin"), `${bundle}!`)), "but the shipped copy is"],
  ];
  for (const [name, arrange, expected] of refusals) {
    manifest({ claude: ["dist/docs-bundle.bin"] });
    writeFileSync(join(shared, "docs-bundle.bin"), bundle);
    check(`the intact layout reads before: ${name}`, sharedPlacements("claude", payload).length === 1);
    arrange();
    const message = refusal(() => sharedPlacements("claude", payload));
    check(`refuses ${name}`, message.includes(expected) && message.endsWith("- reinstall cotal-ai"), message);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-shared-files smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail ? 1 : 0);
