/**
 * A Hermes launch's variant is the reasoning effort its managed profile sets (src/extension.ts,
 * src/launch.ts, src/models.ts): buildLaunch hands it to the launcher, which checks it against the
 * efforts the installed Hermes takes and writes it as `agent.reasoning_effort`.
 *
 * The efforts Hermes takes are read through uv; here the read is a recorded stand-in, and
 * models.smoke.ts runs the real catalog script for them.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardLaunchArtifacts, type LaunchOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { hermesConnector } from "../src/extension.js";
import { LaunchRefused, launchEffort, setupProfile } from "../src/launch.js";
import { hermesEfforts } from "../src/models.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();
const refusal = (fn: () => unknown): Error | undefined => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
};

for (const k of ["COTAL_VARIANT", "COTAL_HERMES_ADOPT_HOME", "COTAL_EVENTS"]) delete process.env[k];
const owned: string[] = [];
const build = (opts: Partial<LaunchOpts>) => {
  const spec = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-effort", events: false, ...opts });
  owned.push(...spec.artifacts ?? []);
  return spec.env ?? {};
};

check("the connector declares model variants", hermesConnector.supportsModelVariant === true);
check("a launch's variant reaches the launcher", build({ variant: "high" }).COTAL_VARIANT === "high");
check("a launch without one sets none", !("COTAL_VARIANT" in build({})));
process.env.COTAL_HERMES_ADOPT_HOME = "/srv/operator/.hermes";
const adoptBuild = refusal(() => build({ variant: "high" }));
check("an adopted profile refuses a variant, since its own config.yaml sets the effort",
  /COTAL_HERMES_ADOPT_HOME/.test(adoptBuild?.message ?? "") && /reasoning effort/.test(adoptBuild?.message ?? ""), adoptBuild?.message);
delete process.env.COTAL_HERMES_ADOPT_HOME;
discardLaunchArtifacts(owned);

const config = {
  name: "reviewer", role: "review", space: "smoke", servers: "nats://127.0.0.1:4222", kind: "agent" as const, tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const home = mkdtempSync(join(tmpdir(), "cotal-hermes-effort-"));
setupProfile(home, { model: "vendor/m", config, effort: "xhigh" });
check("the managed profile sets the effort as Hermes's agent.reasoning_effort",
  /^agent:\n  reasoning_effort: "xhigh"$/m.test(readFileSync(join(home, "config.yaml"), "utf8")));
setupProfile(home, { model: "vendor/m", config });
check("a profile without one leaves Hermes's default", !/^agent:/m.test(readFileSync(join(home, "config.yaml"), "utf8")));
rmSync(home, { recursive: true, force: true });

const HERMES = ["none", "minimal", "low", "medium", "high", "xhigh"];
let reads = 0;
const efforts = () => {
  reads++;
  return HERMES;
};
check("with no variant the launcher reads no efforts and sets none", launchEffort(undefined, efforts) === undefined && reads === 0);
process.env.COTAL_VARIANT = " xhigh ";
check("a variant this Hermes takes is the profile's effort", launchEffort(undefined, efforts) === "xhigh" && reads === 1);
process.env.COTAL_VARIANT = "max";
const unknown = refusal(() => launchEffort(undefined, efforts));
check("a variant this Hermes does not take is refused, naming the efforts it does",
  unknown instanceof LaunchRefused && unknown.message.includes('"max"') && unknown.message.includes(HERMES.join(", ")), unknown?.message);
reads = 0;
const adopted = refusal(() => launchEffort("/srv/operator/.hermes", efforts));
check("the launcher refuses a variant on an adopted profile before reading any",
  adopted instanceof LaunchRefused && /agent\.reasoning_effort/.test(adopted.message) && reads === 0, adopted?.message);
delete process.env.COTAL_VARIANT;

const calls: { file: string; args: readonly string[] }[] = [];
const read = hermesEfforts({
  env: { COTAL_HERMES_UV_BIN: "/opt/uv" },
  execFileImpl: (file, args) => {
    calls.push({ file, args });
    return 'warming up\n["none", "low", "high"]\n';
  },
});
check("the efforts are the catalog script's last line, read through the launch's uv",
  JSON.stringify(read) === '["none","low","high"]' && calls[0]?.file === "/opt/uv" && calls[0].args.at(-1) === "efforts" && calls[0].args.includes("-P"), calls);
const failed = refusal(() => hermesEfforts({ execFileImpl: () => { throw new Error("exit 2"); } }));
check("a read that fails throws", /could not read the reasoning efforts/.test(failed?.message ?? "") && /exit 2/.test(failed?.message ?? ""), failed?.message);
const empty = refusal(() => hermesEfforts({ execFileImpl: () => "[]\n" }));
check("a read that prints no efforts throws", /no list of reasoning efforts/.test(empty?.message ?? ""), empty?.message);

finish();
