#!/usr/bin/env node
import { verifyNative } from "./native-contract.mjs";

try {
  for (const platform of ["win32", "darwin"]) for (const arch of ["x64", "arm64"]) verifyNative(platform, arch);
  console.log("Native process identity: Windows and macOS bindings verified for both architectures");
} catch (cause) {
  throw new Error("@cotal-ai/workspace requires source-matched Windows and macOS x64 and arm64 identity bindings before pack or publish", { cause });
}
