/**
 * The Codex model catalog, read from a fake `codex app-server` that answers `model/list` as
 * codex-cli 0.172.0 was measured to (model-list-app-server.mjs). The catalog is read through core's
 * `readModelCatalog`, so a row whose defaults contradict its own values fails the read.
 *
 * Covered: each listed model, the one default model, each row's description and default reasoning
 * effort, the `fast` toggle with its default from Codex's default service tier, `ultra` kept as an
 * ordinary effort, and no `modes` key on a row that offers no fast tier.
 *
 * Run: pnpm smoke:codex-model-catalog
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModelCatalog, type ModelInfo } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { codexConnector } from "../src/index.js";

const { check, finish } = createSuite();
const recorded = JSON.parse(readFileSync(new URL("./fixtures/model-list-0.172.json", import.meta.url), "utf8")) as {
  data: { id: string; description: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[];
};
// Codex 0.172.0's default reasoning effort for each model, as measured.
const LOW = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"];
const MEDIUM = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
const FAST_BY_DEFAULT = ["gpt-6-sol", "gpt-6-luna"];

const dir = mkdtempSync(join(tmpdir(), "cotal-codex-models-"));
const bin = join(dir, "codex");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./model-list-app-server.mjs", import.meta.url))}" "$@"\n`);
chmodSync(bin, 0o700);
process.env.COTAL_CODEX_BIN = bin;
const ids = (rows: ModelInfo[]) => rows.map((m) => m.id).sort();
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

try {
  const { models } = await readModelCatalog(codexConnector, {});
  check("every model Codex lists is a catalog row (11)", models.length === 11 && same(ids(models), recorded.data.map((m) => m.id)), ids(models));

  const defaults = models.filter((m) => m.isDefault === true);
  check("exactly one default model, gpt-6.2-sol", defaults.length === 1 && defaults[0]!.id === "gpt-6.2-sol", ids(defaults));
  check("no row carries isDefault: false", models.every((m) => m.isDefault === true || !("isDefault" in m)));

  const described = models.filter((m) => !!m.description && m.description === recorded.data.find((r) => r.id === m.id)!.description);
  check("every row carries Codex's description (11)", described.length === 11, described.length);

  const byEffort = (effort: string) => ids(models.filter((m) => m.defaultVariant === effort));
  check("default effort low on the six models Codex runs at low", byEffort("low").length === 6 && same(byEffort("low"), LOW), byEffort("low"));
  check("default effort medium on the five models Codex runs at medium", byEffort("medium").length === 5 && same(byEffort("medium"), MEDIUM), byEffort("medium"));

  const toggles = models.filter((m) => m.modes?.length === 1 && m.modes[0]!.id === "fast" && m.modes[0]!.label === "Fast" && m.modes[0]!.kind === "toggle");
  check("every row has one mode, the Fast toggle (11)", toggles.length === 11, toggles.length);
  const fastOn = ids(models.filter((m) => m.modes?.[0]?.default === true));
  check("Fast defaults on for gpt-6-sol and gpt-6-luna only", same(fastOn, FAST_BY_DEFAULT), fastOn);

  const ultraListed = recorded.data.filter((r) => r.supportedReasoningEfforts.some((e) => e.reasoningEffort === "ultra")).map((r) => r.id);
  const ultra = ids(models.filter((m) => m.variants?.some((v) => v.name === "ultra")));
  check("ultra is an effort on the eight models Codex lists it for", ultra.length === 8 && same(ultra, ultraListed), ultra);

  process.env.FAKE_CODEX_NO_TIERS = "gpt-5.5";
  const bare = (await readModelCatalog(codexConnector, {})).models;
  const withModes = bare.filter((m) => "modes" in m);
  check(
    "a model that offers no fast tier has no modes key, and the rest keep theirs",
    !("modes" in bare.find((m) => m.id === "gpt-5.5")!) && withModes.length === 10,
    ids(withModes),
  );
} finally {
  delete process.env.COTAL_CODEX_BIN;
  delete process.env.FAKE_CODEX_NO_TIERS;
  rmSync(dir, { recursive: true, force: true });
}
finish();
