import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ModelCatalog, ModelCatalogOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { opencodeConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("the fake opencode binaries are POSIX shebang scripts");

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

/** A fake OpenCode 2.x whose `serve --stdio` speaks the real protocol: it prints `{"url":...}` once it
 *  listens, takes its basic-auth password from OPENCODE_PASSWORD, and exits when its stdin closes. Until
 *  `settleMs` has passed, GET /api/plugin lists nothing and GET /api/model answers `early`, as a real
 *  server does while its plugins load; then the plugin list fills and GET /api/model answers `settled`. */
function fakeServe(name: string, { boot = "", ...spec }: { settleMs?: number; early?: string; settled?: string; modelStatus?: number; boot?: string }): string {
  const bin = join(dir, `${name}.mjs`);
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("opencode v2.4.1"); process.exit(0); }
appendFileSync(${JSON.stringify(`${bin}.argv`)}, args.join(" ") + "\\n");
writeFileSync(${JSON.stringify(`${bin}.pid`)}, String(process.pid));
const spec = ${JSON.stringify({ settleMs: 0, early: '{"data":[]}', settled: '{"data":[]}', modelStatus: 200, ...spec })};
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
const started = Date.now();
process.stdin.on("end", () => process.exit(0)).resume();
${boot}
const server = createServer((req, res) => {
  if (!process.env.OPENCODE_PASSWORD || req.headers.authorization !== auth) return res.writeHead(401).end();
  const settled = Date.now() - started >= spec.settleMs;
  if (req.url === "/api/plugin") return res.writeHead(200).end(JSON.stringify({ data: settled ? [{ id: "opencode.agent" }] : [] }));
  if (req.url === "/api/model") return res.writeHead(spec.modelStatus).end(settled ? spec.settled : spec.early);
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port })));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function fakePid(bin: string): number {
  try {
    return Number(readFileSync(`${bin}.pid`, "utf8"));
  } catch {
    return NaN;
  }
}

async function exited(pid: number, withinMs: number): Promise<boolean> {
  for (let waited = 0; Number.isInteger(pid) && waited < withinMs; waited += 50) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return true;
    }
  }
  return false;
}

const SOURCE = "opencode serve --stdio GET /api/model";

try {
  const SECRET = "sk-fixture-secret-must-not-surface";
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/opencode2-model-list.json", import.meta.url), "utf8"));
  recorded.data[0].settings.apiKey = SECRET;
  recorded.data[1].headers = { authorization: `Bearer ${SECRET}` };
  recorded.data[1].variants[0].headers = { authorization: `Bearer ${SECRET}` };
  // Before the plugins load, a real server lists some providers' models and not others.
  const partial = JSON.stringify({ ...recorded, data: recorded.data.slice(0, 1) });

  const v2 = fakeServe("oc2", { settleMs: 400, early: partial, settled: JSON.stringify(recorded) });
  const listed = await list(v2);
  const reference = readFileSync(new URL("../../../docs/opencode-connector-reference.mdx", import.meta.url), "utf8");
  check(
    "the reference describes the available 2.x catalog without an obsolete limitation",
    listed.catalog?.source === SOURCE && reference.includes(`\`${SOURCE}\``) && !reference.includes("lists no OpenCode catalog"),
  );
  const effort = (...names: string[]) => names.map((name) => ({ name }));
  check(
    "on 2.x the catalog waits for OpenCode's plugins, then lists every model as provider/model ids with their variants",
    listed.error === "" &&
      isDeepStrictEqual(listed.catalog, {
        source: SOURCE,
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
    "on 2.x the catalog read starts a private loopback server with its password in the environment, never argv",
    argv(v2) === "serve --stdio --hostname 127.0.0.1 --port 0",
    argv(v2),
  );
  check("on 2.x the private server is stopped once the catalog is read", await exited(fakePid(v2), 2_000));
  check(
    "on 2.x the catalog carries no provider key, header or settings from the reply",
    (listed.catalog?.models.length ?? 0) > 0 && !JSON.stringify(listed.catalog).includes(SECRET),
    listed.catalog,
  );

  const empty = await list(fakeServe("oc2-empty", {}));
  check("on 2.x an empty model list is reported unavailable, never as an empty catalog", unavailableOnly(empty, /listed no models/), empty);

  const refused = await list(fakeServe("oc2-refused", { modelStatus: 503, settled: '{"_tag":"ServiceUnavailableError"}' }));
  check("on 2.x a refused read is reported unavailable with the server's status, not thrown", unavailableOnly(refused, /HTTP 503/), refused);

  const notJson = await list(fakeServe("oc2-text", { settled: "opencode v2.4.1" }));
  check("on 2.x a reply that is not JSON is reported unavailable, not thrown", unavailableOnly(notJson, /other than JSON/), notJson);

  const noProvider = await list(fakeServe("oc2-shape", { settled: '{"location":{"directory":"/work"},"data":[{"id":"big-pickle","name":"Big Pickle","variants":[]}]}' }));
  check("on 2.x a model without a providerID is reported unavailable, not thrown", unavailableOnly(noProvider, /providerID/), noProvider);

  const noData = await list(fakeServe("oc2-nodata", { settled: '{"location":{"directory":"/work"}}' }));
  check("on 2.x a reply without a model list is reported unavailable, not thrown", unavailableOnly(noData, /answered no list/), noData);

  const early = await list(fakeServe("oc2-exit", { boot: "process.exit(3);" }));
  check("on 2.x a server that exits before it listens is reported unavailable with its exit code", unavailableOnly(early, /exited \(3\)/), early);

  // Both waits run at once: each takes its whole bound.
  const silentBin = fakeServe("oc2-silent", { boot: "await new Promise(() => {});" });
  const stuckBin = fakeServe("oc2-stuck", { settleMs: 1e9 });
  const [silent, stuck] = await Promise.all([list(silentBin), list(stuckBin)]);
  check(
    "on 2.x plugins that never finish loading are reported unavailable after OpenCode's own 5 s wait, not hung",
    unavailableOnly(stuck, /plugins did not finish loading within 5 s/) && stuck.ms >= 4_500 && stuck.ms < 9_000,
    { ...stuck, returned: undefined },
  );
  check(
    "on 2.x a server that reports no address within 6 seconds is reported unavailable, not hung",
    unavailableOnly(silent, /reported no address within 6 s/) && silent.ms >= 5_500 && silent.ms < 11_000,
    { ...silent, returned: undefined },
  );
  check("on 2.x the server that reported no address is killed", await exited(fakePid(silentBin), 2_000));
  check("on 2.x the server whose plugins never loaded is stopped", await exited(fakePid(stuckBin), 2_000));

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
