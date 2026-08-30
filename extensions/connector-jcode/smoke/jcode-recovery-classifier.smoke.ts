import assert from "node:assert/strict";
import { HarnessError } from "@1jehuang/jcode-sdk";
import {
  PERMANENT_BRIDGE_CONNECT_CAUSE_CODES,
  PERMANENT_BRIDGE_RECOVERY_CODES,
  permanentBridgeRecoveryFailure,
} from "../src/host.js";

let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const directCodes = [
  "handshake_failed",
  "invalid_instance_home",
  "invalid_request",
  "jcode_not_found",
  "unknown_request",
  "unknown_session",
  "unsupported_version",
];
const eacces = new HarnessError("connect_failed", "permission denied");
eacces.cause = Object.assign(new Error("permission denied"), { code: "EACCES" });

check(
  "the permanent recovery contract contains exactly seven direct SDK codes plus EACCES",
  PERMANENT_BRIDGE_RECOVERY_CODES.size === 7 &&
    PERMANENT_BRIDGE_CONNECT_CAUSE_CODES.size === 1 &&
    PERMANENT_BRIDGE_CONNECT_CAUSE_CODES.has("EACCES") &&
    directCodes.every((code) => PERMANENT_BRIDGE_RECOVERY_CODES.has(code)) &&
    directCodes.filter((code) => permanentBridgeRecoveryFailure(new HarnessError(code, "synthetic refusal"))).length === 7 &&
    permanentBridgeRecoveryFailure(eacces),
  {
    direct: [...PERMANENT_BRIDGE_RECOVERY_CODES],
    connectCauses: [...PERMANENT_BRIDGE_CONNECT_CAUSE_CODES],
    eacces: permanentBridgeRecoveryFailure(eacces),
  },
);
check(
  "an unknown HarnessError code retries inside the bounded window",
  !permanentBridgeRecoveryFailure(new HarnessError("future_sdk_code", "future refusal")),
);

console.log(`JCODE RECOVERY CLASSIFIER SMOKE: ${passed} checks passed`);
