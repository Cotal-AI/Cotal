/**
 * The config layering behind `spawn.env`, exercised through `loadCotalConfig` rather than through
 * the merge function it calls.
 *
 * WHY THIS EXISTS. `spawn` is the first top-level config key besides `connectors`, and adding it
 * uncovered that `mergeConfig` returned `{ connectors }` - so every other top-level key a config
 * file declared was silently discarded on the way through. That was latent rather than harmful only
 * because no such key existed yet. Nothing anywhere referenced `loadCotalConfig`, `mergeConfig` or
 * `spawnEnvAllow`, so the layering path had no coverage at the moment it acquired its first real
 * user, and the fix for the discard had none either.
 *
 * WHY THROUGH `loadCotalConfig`. `mergeConfig` is not exported, and testing a merge by calling it
 * directly would prove the merge works without proving the loader reaches it. These cells write real
 * files to the two real paths and read the result back through the function the CLI and the manager
 * actually call.
 *
 * Run: pnpm smoke:spawn-env-config
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCotalConfig, spawnEnvAllow, type CotalConfig } from "../src/connector-config.js";

const tmp = mkdtempSync(join(tmpdir(), "cotal-spawn-env-cfg-"));
const priorXdg = process.env.XDG_CONFIG_HOME;
let cells = 0;

/** Write the operator-level file and the space-local file, then load through the real entry point.
 *  `undefined` means the file is absent, which is a distinct state from an empty object. */
function load(operator: unknown | undefined, spaceLocal: unknown | undefined): CotalConfig {
  const box = mkdtempSync(join(tmp, "case-"));
  const xdg = join(box, "xdg");
  mkdirSync(join(xdg, "cotal"), { recursive: true });
  process.env.XDG_CONFIG_HOME = xdg;
  if (operator !== undefined) writeFileSync(join(xdg, "cotal", "config.json"), JSON.stringify(operator));
  const root = join(box, "space");
  mkdirSync(join(root, ".cotal"), { recursive: true });
  if (spaceLocal !== undefined) writeFileSync(join(root, ".cotal", "config.json"), JSON.stringify(spaceLocal));
  return loadCotalConfig(root);
}
function cell(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    // A fresh Error, not a mutated one: node bakes the message into the stack string at construction,
    // so reassigning `.message` on the caught AssertionError leaves the printed output unchanged and
    // the cell name never reaches the log. Verified by forcing a cell red, not assumed.
    throw new Error(`cell "${name}": ${(e as Error).message}`, { cause: e });
  }
  cells++;
}

try {
  // --- the discard this PR fixed -------------------------------------------------------------
  // The load-bearing one. Before the fix the merge returned `{ connectors }`, so an operator-level
  // `spawn` block vanished the moment ANY config layering happened - which is every load, since the
  // loader always layers two files. A cell that only ever set `spawn` on one side would pass against
  // the broken merge too, so the space-local file here carries a `connectors` key: that is what makes
  // the merge produce a fresh object and drop everything it does not name.
  cell("operator-level spawn survives layering when the space file declares something else", () => {
    const cfg = load(
      { spawn: { env: ["OPERATOR_ONLY_KEY"] }, connectors: { claude: {} } },
      { connectors: { opencode: {} } },
    );
    assert.deepEqual(
      spawnEnvAllow(cfg),
      ["OPERATOR_ONLY_KEY"],
      "an operator-level spawn.env was dropped while layering a space-local file that only sets " +
        "connectors. The merge is discarding top-level keys it does not name.",
    );
    assert.ok(cfg.connectors?.claude && cfg.connectors?.opencode, "connectors from both sides should survive");
  });

  // --- replace, not union --------------------------------------------------------------------
  cell("a space-local spawn.env replaces the operator-level list rather than unioning it", () => {
    const cfg = load({ spawn: { env: ["WIDE_A", "WIDE_B"] } }, { spawn: { env: ["NARROW"] } });
    assert.deepEqual(
      spawnEnvAllow(cfg),
      ["NARROW"],
      "layering unioned two allow-lists. Union widens the narrower file, which is the wrong " +
        "direction for a containment setting: a space that names one variable means one.",
    );
  });

  // --- the three distinct empty states ---------------------------------------------------------
  // `absent`, `{}` and `[]` are three different statements and the loader must not conflate them.
  cell("no spawn block anywhere means no allow-list, so the child inherits", () => {
    assert.equal(spawnEnvAllow(load(undefined, undefined)), undefined);
    assert.equal(spawnEnvAllow(load({ connectors: {} }, { connectors: {} })), undefined);
  });

  cell("an empty env ARRAY is a real policy: the OS allow-list alone, not 'unset'", () => {
    const cfg = load(undefined, { spawn: { env: [] } });
    const allow = spawnEnvAllow(cfg);
    assert.notEqual(allow, undefined, "an empty array must not read as an absent policy");
    assert.deepEqual(allow, [], "an empty array means the OS allow-list alone");
  });

  // The behaviour a reviewer flagged as a footgun, pinned deliberately rather than left to be
  // rediscovered. Replace semantics mean a space-local `spawn` block replaces the operator-level one
  // WHOLE, so `{}` is a space saying "no allow-list here" and the machine-wide list does not apply.
  // That is the documented rule rather than an oversight, and it is written down as a cell so that
  // changing it has to be a decision rather than a drift.
  cell("a space-local empty spawn block drops the operator-level allow-list (replace, not merge)", () => {
    const cfg = load({ spawn: { env: ["MACHINE_WIDE"] } }, { spawn: {} });
    assert.equal(
      spawnEnvAllow(cfg),
      undefined,
      "an empty space-local spawn block should replace the operator-level one outright. If this " +
        "starts falling through to the operator list, a space can no longer opt out of machine-wide " +
        "containment, which is a behaviour change and not a bug fix.",
    );
  });

  // --- when the replace decision must be revisited ---------------------------------------------
  // Wholesale replace is safe while `env` is the only reason to write a `spawn` block. The day the
  // shape grows a sibling, someone setting only that sibling silently drops `spawn.env`, and the
  // trade-off that made replace correct no longer holds. That is not a defect today; it is a
  // decision with an expiry, so the expiry is a check rather than a comment.
  cell("SpawnConfig still has exactly one key, which is what makes wholesale replace safe", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "connector-config.ts"),
      "utf8",
    );
    const body = src.match(/export interface SpawnConfig\s*\{([\s\S]*?)\n\}/)?.[1];
    assert.ok(body !== undefined, "could not find SpawnConfig, so this check is not reading the source");
    const keys = [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
    assert.deepEqual(
      keys,
      ["env"],
      "SpawnConfig grew a key. `spawn` replaces WHOLESALE, so a config that sets only the new key " +
        "silently drops spawn.env for that space. Revisit the replace decision now that there is a " +
        "reason to write a spawn block other than declaring an allow-list.",
    );
  });

  assert.equal(cells, 6, "not every cell ran");
  console.log(`spawn-env-config smoke: ${cells} cells - layering, replace-not-union, three empty states, replace expiry`);
} finally {
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdg;
  rmSync(tmp, { recursive: true, force: true });
}
