import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
if (typeof version !== "string" || !version.trim())
  throw new Error("the cotal-lang package manifest has no version");

/** Captured once per isolate, so a later install cannot change the host's package identity. */
export const PACKAGE_VERSION = version;
