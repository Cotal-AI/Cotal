/**
 * The user-mode tool-results serving file through launch material (no NATS) — run with:
 *   pnpm --dir extensions/connector-core exec tsx smoke/tool-result-serving-launch.smoke.ts
 *
 * Drives the shipped materialEnv and core readLaunchMaterial: the serving-file path rides only a
 * static-auth or user-mode launch (never an open one), only as an absolute path inside the 0600
 * launch material, and never in argv or env. The session half (serveLaunchedToolResults re-reading the
 * file, stopping when it is removed or lapses) needs a live mesh and is NOT exercised here.
 */
import assert from "node:assert/strict";
import { readLaunchMaterial, LAUNCH_MATERIAL_ENV } from "@cotal-ai/core";
import { materialEnv } from "../src/launch.js";

let checks = 0;
const ok = (value: unknown, message: string): void => { assert.ok(value, message); checks++; };
const throws = (run: () => unknown, message: string): void => { assert.throws(run, message); checks++; };

const userAuth = { owner: "u_" + "a".repeat(26), actor: "seat", sentinelCredsPath: "/tmp/sentinel.creds", bearerCmd: ["cotal", "bearer"] };
const file = "/tmp/seat.tool-results.json";

throws(() => materialEnv({ toolResultsServing: { file } }), "an open launch cannot carry a serving file");
const staticEnv = materialEnv({ creds: "creds", toolResultsServing: { file } });
ok(readLaunchMaterial(staticEnv[LAUNCH_MATERIAL_ENV]!).toolResultsServing?.file === file, "a static launch carries the serving file its manager renews");
const env = materialEnv({ userAuth, toolResultsServing: { file } });
ok(Object.keys(env).length === 1 && typeof env[LAUNCH_MATERIAL_ENV] === "string", "only the material path reaches the env");
ok(!Object.values(env).some((v) => v.includes(file)), "the serving-file path is not in the env itself");
const material = readLaunchMaterial(env[LAUNCH_MATERIAL_ENV]!);
ok(material.toolResultsServing?.file === file && material.userAuth?.owner === userAuth.owner, "the launch material carries the serving file beside the user-mode identity");

console.log(`tool-result-serving-launch smoke: ${checks} checks passed`);
