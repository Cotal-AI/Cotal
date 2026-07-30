import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof manifest.version !== "string")
  throw new Error("connector-codex package.json has no version");

export const CONNECTOR_VERSION = manifest.version;
