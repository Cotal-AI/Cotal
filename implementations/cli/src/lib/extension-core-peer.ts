import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CommandFailure, hostPackageDir, oneLine } from "@cotal-ai/workspace";
import { seedWriterKind } from "../seed/paths.js";

const semver = createRequire(import.meta.url)("semver") as {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, opts: { includePrerelease: boolean }): boolean;
};

export function assertExtensionCorePeer(pkg: string, range: string | undefined): void {
  if (range === undefined || range === "*") return;
  const core = "@cotal-ai/core";
  const { version } = JSON.parse(readFileSync(join(hostPackageDir(core), "package.json"), "utf8")) as { version: string };
  const declaration = `${oneLine(pkg)} declares ${core} ${oneLine(JSON.stringify(range))}`;
  if (typeof range !== "string" || semver.validRange(range) === null) {
    throw new CommandFailure("refused", "SCHEMA_INVALID", `${declaration}, which is not a valid version range. This CLI ships ${core} ${oneLine(version)}.`, {
      remedy: "Use an extension build with a valid core peer range, or correct the range in the local package.json before adding it again.",
    });
  }
  const parsed = semver.valid(version);
  if ((parsed === "0.0.0" || parsed?.startsWith("0.0.0-")) && seedWriterKind() === "checkout") return;
  if (semver.satisfies(version, range, { includePrerelease: true })) return;
  throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${declaration}, but this CLI ships ${core} ${oneLine(version)}.`, {
    remedy: "Use an extension build that supports this core, or list CLI releases with `npm view cotal-ai versions --json` and choose one that satisfies the range.",
  });
}
