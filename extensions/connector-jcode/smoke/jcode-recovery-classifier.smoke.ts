import assert from "node:assert/strict";
import { HarnessError } from "@1jehuang/jcode-sdk";
import {
  PERMANENT_BRIDGE_CONNECT_CAUSE_CODES,
  PERMANENT_BRIDGE_RECOVERY_CODES,
  isJcodeBusyRefusal,
  permanentBridgeRecoveryFailure,
} from "../src/host.js";

let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
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
// The text and code real Jcode 0.99.0 sent when it refused a manager turn as busy (#5918).
check(
  "only the native busy refusal of a plain send reads as one",
  isJcodeBusyRefusal(new HarnessError("internal", "Already processing a message")) &&
    !isJcodeBusyRefusal(new HarnessError("internal", "Cannot handle context_message while the session is busy. Try again after the current turn finishes.")) &&
    !isJcodeBusyRefusal(new Error("Already processing a message")),
);

console.log(`JCODE RECOVERY CLASSIFIER SMOKE: ${passed} checks passed`);
