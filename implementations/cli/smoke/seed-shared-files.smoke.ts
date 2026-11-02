/**
 * A published `cotal-ai` ships the docs data every connector bundle reads (`docs-bundle.bin`,
 * `docs-index.bin`) once, in `seeded-connectors/_shared/`, with a `placements.json` naming every path
 * the prepack removed it from. `sharedPlacements` is the one reader of that manifest: the seed store
 * restores each placement from it and `cotal update` compares each installed copy with it. These cells
 * drive it over a published layout written here, then over each way the manifest or a shared file can
 * be wrong. The packed tarball, the restored install and the verify are proven end to end by
 * `smoke:seed-tarball:live`.
 * Broker-free, no network. Run: pnpm smoke:seed-shared-files
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { sharedPlacements } from "../src/seed/shared.js";

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
