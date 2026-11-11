/**
 * OpenCode model catalog test (no test runner): `opencodeConnector.listModels` against fake
 * `opencode` binaries, one per line and failure shape. No broker and no real OpenCode.
 *
 *   1. 2.x: the catalog comes from `opencode api --standalone GET /api/model`. The recorded reply
 *      (OpenCode 2.2.5, scrubbed) maps to `provider/model` ids with variant names, and nothing from a
 *      model's settings or headers reaches the catalog. A refusal, a reply that is not a model list,
 *      and a read that does not answer within 6 seconds each come back `unavailable`, never thrown
 *      and never hung.
 *   2. 1.x: `opencode models --pure --verbose` is parsed as before, synchronously, with `--refresh`
 *      passed through and a failed read still thrown.
 *
 * Run: pnpm smoke:opencode-model-catalog
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ModelCatalog, ModelCatalogOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { opencodeConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("the fake opencode binaries are POSIX shell scripts");

const { check, finish } = createSuite();
delete process.env.COTAL_OPENCODE_BIN;
const dir = mkdtempSync(join(tmpdir(), "oc-catalog-"));

/** A fake `opencode` that answers `--version` with `version`, records any other argv to
 *  `<bin>.argv`, and then runs `body`. */
function fakeOpenCode(name: string, version: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\necho "$*" >> '${bin}.argv'\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function argv(bin: string): string {
  try {
    return readFileSync(`${bin}.argv`, "utf8").trim();
  } catch {
    return "(no call beyond --version)";
  }
}

async function list(bin: string, opts: ModelCatalogOpts = {}) {
  const started = Date.now();
  let returned: ModelCatalog | Promise<ModelCatalog> | undefined;
  let catalog: ModelCatalog | undefined;
  let error = "";
  try {
    returned = opencodeConnector.listModels!({ ...opts, resolvedBinaries: { opencode: bin } });
    catalog = await returned;
  } catch (e) {
    error = (e as Error).message;
  }
  return { returned, catalog, error, ms: Date.now() - started };
}

const unavailableOnly = (r: Awaited<ReturnType<typeof list>>, reason: RegExp) =>
  r.error === "" && r.catalog?.models.length === 0 && reason.test(r.catalog.unavailable ?? "");

try {
  // ── 1. 2.x ─────────────────────────────────────────────────────────────────────────────────────
  const SECRET = "sk-fixture-secret-must-not-surface";
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/opencode2-model-list.json", import.meta.url), "utf8"));
  recorded.data[0].settings.apiKey = SECRET;
  recorded.data[1].headers = { authorization: `Bearer ${SECRET}` };
  recorded.data[1].variants[0].headers = { authorization: `Bearer ${SECRET}` };
  const replyFile = join(dir, "reply.json");
  writeFileSync(replyFile, JSON.stringify(recorded, null, 2));

  const v2 = fakeOpenCode("oc2", "opencode v2.2.5", `cat '${replyFile}'`);
  const listed = await list(v2);
  const effort = (...names: string[]) => names.map((name) => ({ name }));
  check(
    "on 2.x the catalog lists the server's models as provider/model ids with their variants",
    listed.error === "" &&
      isDeepStrictEqual(listed.catalog, {
        source: "opencode api --standalone GET /api/model",
        models: [
          { id: "opencode/big-pickle", provider: "opencode", name: "Big Pickle" },
          { id: "opencode/deepseek-v4.1-flash-free", provider: "opencode", name: "DeepSeek V4.1 Flash Free", variants: effort("low", "high", "max") },
          {
            id: "opencode/inkling-2-small-free",
            provider: "opencode",
            name: "Inkling 2 Small Free",
            variants: effort("none", "minimal", "low", "medium", "high", "max"),
          },
        ],
      }),
    listed,
  );
  check(
    "on 2.x the catalog read asks a private standalone server, never the background service",
    argv(v2) === "api --standalone GET /api/model",
    argv(v2),
  );
  check(
    "on 2.x the catalog carries no provider key, header or settings from the reply",
    (listed.catalog?.models.length ?? 0) > 0 && !JSON.stringify(listed.catalog).includes(SECRET),
    listed.catalog,
  );

  const refused = await list(fakeOpenCode("oc2-refused", "opencode v2.2.5", `echo '{"_tag":"ServiceUnavailableError"}'\necho 'HTTP 503 Service Unavailable' >&2\nexit 1`));
  check("on 2.x a refused read is reported unavailable with OpenCode's reason, not thrown", unavailableOnly(refused, /HTTP 503 Service Unavailable/), refused);

  const notJson = await list(fakeOpenCode("oc2-text", "opencode v2.2.5", `echo 'opencode v2.2.5'`));
  check("on 2.x a reply that is not JSON is reported unavailable, not thrown", unavailableOnly(notJson, /not JSON/), notJson);

  const noProvider = await list(fakeOpenCode("oc2-shape", "opencode v2.2.5", `echo '{"location":{"directory":"/work"},"data":[{"id":"big-pickle","name":"Big Pickle","variants":[]}]}'`));
  check("on 2.x a model without a providerID is reported unavailable, not thrown", unavailableOnly(noProvider, /providerID/), noProvider);

  const noData = await list(fakeOpenCode("oc2-nodata", "opencode v2.2.5", `echo '{"location":{"directory":"/work"}}'`));
  check("on 2.x a reply without a model list is reported unavailable, not thrown", unavailableOnly(noData, /model list/), noData);

  const pidFile = join(dir, "slow.pid");
  const slow = await list(fakeOpenCode("oc2-slow", "opencode v2.2.5", `echo $$ > '${pidFile}'\nexec sleep 60`));
  check(
    "on 2.x a read that does not answer within 6 seconds is reported unavailable, not hung",
    unavailableOnly(slow, /6 seconds/) && slow.ms >= 5_500 && slow.ms < 11_000,
    { ...slow, returned: undefined },
  );
  let slowKilled = false;
  let pid = NaN;
  try {
    pid = Number(readFileSync(pidFile, "utf8"));
  } catch {
    // No pid file: the slow read never ran, so nothing here proves a kill.
  }
  // The catalog settles at the deadline without waiting for the exit, so give the kill time to be reaped.
  for (let waited = 0; Number.isInteger(pid) && !slowKilled && waited < 2_000; waited += 50) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      slowKilled = true;
    }
  }
  check("on 2.x the timed-out read's process is killed", slowKilled);

  // ── 2. 1.x ─────────────────────────────────────────────────────────────────────────────────────
  const v1Out = [
    "opencode/big-pickle",
    "{",
    '  "id": "big-pickle",',
    '  "providerID": "opencode",',
    '  "name": "Big Pickle",',
    '  "variants": {',
    '    "high": { "reasoningEffort": "high" },',
    '    "off": { "disabled": true }',
    "  }",
    "}",
    "anthropic/claude-sonnet-4-5",
  ].join("\n");
  const v1OutFile = join(dir, "v1.out");
  writeFileSync(v1OutFile, `${v1Out}\n`);
  const v1 = fakeOpenCode("oc1", "1.18.23", `cat '${v1OutFile}'`);
  const one = await list(v1);
  check(
    "on 1.x the catalog is parsed from opencode models --pure --verbose as before",
    one.error === "" &&
      isDeepStrictEqual(one.catalog, {
        source: "opencode models --pure --verbose",
        models: [
          { id: "opencode/big-pickle", provider: "opencode", name: "Big Pickle", variants: [{ name: "high", options: { reasoningEffort: "high" } }] },
          { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
        ],
      }),
    one,
  );
  check("on 1.x the catalog is returned synchronously as before", one.returned !== undefined && !(one.returned instanceof Promise));
  await list(v1, { refresh: true });
  check("on 1.x --refresh is passed through as before", argv(v1) === "models --pure --verbose\nmodels --pure --verbose --refresh", argv(v1));

  const v1Failed = await list(fakeOpenCode("oc1-failed", "1.18.23", "echo 'boom' >&2\nexit 1"));
  check("on 1.x a failed models read still throws as before", v1Failed.catalog === undefined && /^opencode models failed: boom$/.test(v1Failed.error), v1Failed);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

finish();
