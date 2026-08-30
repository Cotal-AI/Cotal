/**
 * Effort-refusal diagnostics must name the requested model pin, not the session default
 * RuntimeInfo still reports after setModel. Measured: a CLI spawn that died on a variant-tier
 * refusal recorded deepseek-v4-pro despite --model grok-4.6.
 *
 * Pure: no broker. Grades `effortRefusalModel` — the same helper the host uses. Run:
 *   pnpm smoke:jcode-effort-model
 */
import { effortRefusalModel, jcodeEffortRefusal } from "../src/startup-diagnostics.js";

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

const requested = "grok-4.6";
const runtimeDefault = "deepseek-v4-pro";
check(
  "a requested pin wins over a different RuntimeInfo model",
  effortRefusalModel(requested, runtimeDefault) === requested,
  effortRefusalModel(requested, runtimeDefault),
);
check(
  "no pin falls back to RuntimeInfo (the session default)",
  effortRefusalModel(undefined, runtimeDefault) === runtimeDefault,
);
check(
  "neither pin nor RuntimeInfo names the provider-default placeholder",
  effortRefusalModel(undefined, undefined) === "(the provider default)",
);

const err = jcodeEffortRefusal(new Error("accepted tiers: low, high"), "xhigh", effortRefusalModel(requested, runtimeDefault));
check("effort refusal carries the requested pin as effectiveModel", err.effectiveModel === requested, err.effectiveModel);
check("effort refusal does not carry the session default when a pin was requested", err.effectiveModel !== runtimeDefault);

const EXPECTED = 5;
check(
  `every cell ran - ${EXPECTED} expected`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`JCODE EFFORT-MODEL SMOKE ${fail === 0 ? "OK" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
