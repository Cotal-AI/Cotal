import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ModelCatalog, ModelCatalogOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { opencodeConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("the fake opencode binaries are POSIX shell scripts");

const { check, finish } = createSuite();
delete process.env.COTAL_OPENCODE_BIN;
const dir = mkdtempSync(join(tmpdir(), "oc-catalog-"));

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

const SOURCE2 = "opencode serve --stdio: GET /api/model";
const FAKE_SERVE = fileURLToPath(new URL("./fixtures/fake-opencode2-serve.mjs", import.meta.url));

/** A fake 2.x binary whose servers settle `settleMs` after their first request (never when null). */
function fakeServer(name: string, config: { settleMs: number | null; modelBody: string; modelStatus?: number }) {
  const pidFile = join(dir, `${name}.pids`);
  const configFile = join(dir, `${name}.json`);
  writeFileSync(configFile, JSON.stringify({ ...config, pidFile }));
  return { bin: fakeOpenCode(name, "opencode v2.4.1", `exec '${process.execPath}' '${FAKE_SERVE}' '${configFile}' "$@"`), pidFile };
}

/** Whether every pid written to `pidFile` is gone within 2 s. A read settles without waiting for
 *  the exit, so the kill gets time to be reaped. A missing file means no server ran. */
async function gone(pidFile: string): Promise<boolean> {
  let pids: number[];
  try {
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
  } catch {
    return false;
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let waited = 0; waited < 2_000; waited += 50) {
    if (pids.every((pid) => Number.isInteger(pid) && !alive(pid))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  const SECRET = "sk-fixture-secret-must-not-surface";
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/opencode2-model-list.json", import.meta.url), "utf8"));
  recorded.data[0].settings.apiKey = SECRET;
  recorded.data[1].headers = { authorization: `Bearer ${SECRET}` };
  recorded.data[1].variants[0].headers = { authorization: `Bearer ${SECRET}` };
  const replyFile = join(dir, "reply.json");
  writeFileSync(replyFile, JSON.stringify(recorded, null, 2));

  const late = fakeServer("oc2", { settleMs: 300, modelBody: JSON.stringify(recorded) });
  const listed = await list(late.bin);
  const reference = readFileSync(new URL("../../../docs/opencode-connector-reference.mdx", import.meta.url), "utf8");
  check(
    "the reference describes the available 2.x catalog without an obsolete limitation",
    listed.catalog?.source === SOURCE2 && reference.includes(`\`${listed.catalog.source}\``) && !reference.includes("lists no OpenCode catalog"),
  );
  const effort = (...names: string[]) => names.map((name) => ({ name }));
  check(
    "on 2.x the catalog waits for OpenCode's plugins to settle, then lists the server's models as provider/model ids with their variants",
    listed.error === "" &&
      isDeepStrictEqual(listed.catalog, {
        source: SOURCE2,
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
    "on 2.x the catalog read starts a private stdio server on loopback with no password on its command line, never the background service",
    argv(late.bin) === "serve --stdio --hostname 127.0.0.1 --port 0",
    argv(late.bin),
  );
  check("on 2.x a read leaves no server process or child behind", await gone(late.pidFile));
  check(
    "on 2.x the catalog carries no provider key, header or settings from the reply",
    (listed.catalog?.models.length ?? 0) > 0 && !JSON.stringify(listed.catalog).includes(SECRET),
    listed.catalog,
  );

  const none = await list(fakeServer("oc2-none", { settleMs: 0, modelBody: JSON.stringify({ location: { directory: "/work" }, data: [] }) }).bin);
  check("on 2.x a list still empty once the plugins settled is reported unavailable, not listed empty", unavailableOnly(none, /no models/), none);

  const refused = await list(fakeOpenCode("oc2-refused", "opencode v2.2.5", `echo 'Error: Missing server password' >&2\nexit 1`));
  check("on 2.x a server that fails to start is reported unavailable with OpenCode's reason, not thrown", unavailableOnly(refused, /Missing server password/), refused);

  const status = await list(fakeServer("oc2-status", { settleMs: 0, modelStatus: 503, modelBody: '{"_tag":"ServiceUnavailableError"}' }).bin);
  check("on 2.x a refused model read is reported unavailable with its HTTP status, not thrown", unavailableOnly(status, /HTTP 503/), status);

  const notJson = await list(fakeServer("oc2-text", { settleMs: 0, modelBody: "opencode v2.2.5" }).bin);
  check("on 2.x a reply that is not JSON is reported unavailable, not thrown", unavailableOnly(notJson, /not JSON/), notJson);

  const noProvider = await list(fakeServer("oc2-shape", { settleMs: 0, modelBody: '{"location":{"directory":"/work"},"data":[{"id":"big-pickle","name":"Big Pickle","variants":[]}]}' }).bin);
  check("on 2.x a model without a providerID is reported unavailable, not thrown", unavailableOnly(noProvider, /providerID/), noProvider);

  const noData = await list(fakeServer("oc2-nodata", { settleMs: 0, modelBody: '{"location":{"directory":"/work"}}' }).bin);
  check("on 2.x a reply without a model list is reported unavailable, not thrown", unavailableOnly(noData, /model list/), noData);

  const unsettled = fakeServer("oc2-unsettled", { settleMs: null, modelBody: JSON.stringify(recorded) });
  const stuck = await list(unsettled.bin);
  check(
    "on 2.x plugins that never settle are reported unavailable within the read's 10 seconds, not listed empty",
    unavailableOnly(stuck, /10 seconds/) && stuck.ms >= 9_500 && stuck.ms < 15_000,
    { ...stuck, returned: undefined },
  );
  check("on 2.x a read that timed out leaves no server process or child behind", await gone(unsettled.pidFile));

  const pidFile = join(dir, "slow.pid");
  const slow = await list(fakeOpenCode("oc2-slow", "opencode v2.2.5", `echo $$ > '${pidFile}'\nexec sleep 60`));
  check(
    "on 2.x a server that does not start within 10 seconds is reported unavailable, not hung",
    unavailableOnly(slow, /10 seconds/) && slow.ms >= 9_500 && slow.ms < 15_000,
    { ...slow, returned: undefined },
  );
  check("on 2.x the timed-out read's process is killed", await gone(pidFile));

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
