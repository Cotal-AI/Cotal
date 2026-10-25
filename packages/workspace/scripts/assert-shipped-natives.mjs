#!/usr/bin/env node
import { verifyNative } from "./native-contract.mjs";

try {
  for (const arch of ["x64", "arm64"]) verifyNative("win32", arch);
  console.log("Windows creation identity: both native architectures verified");
} catch (cause) {
  throw new Error("@cotal-ai/workspace requires source-matched Windows x64 and arm64 identity bindings before pack or publish", { cause });
}
