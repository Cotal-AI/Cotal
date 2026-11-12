import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertSystemdSourceDirectory, systemdUserUnitDirectory } from "@cotal-ai/cli";
import { CommandFailure, localRecordObject, protectedLocalDirectory, readLocalRecordSource } from "@cotal-ai/workspace";
import type { DaemonPaths } from "./endpoint.js";
import { daemonServeArgv, daemonUnitName, renderDaemonUnit, unitReceiptFile } from "./install.js";

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
function refuse(message: string): never {
  throw new CommandFailure("refused", "CONFLICT", `installed coordinate: ${message}`);
}
function canonical(path: string): string {
  if (!isAbsolute(path) || realpathSync(path) !== path) refuse("a path is unavailable or is not canonical");
  return path;
}
function required(path: string, limit: number, privateFile = true): Buffer {
  const bytes = readLocalRecordSource(path, limit, privateFile);
  if (!bytes) refuse("a required local file is absent");
  return bytes;
}
function fileObservation(path: string, uid: number) {
  canonical(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022) !== 0)
    refuse("runtime file is not a protected regular file owned by root or this uid");
  protectedLocalDirectory(dirname(path));
  // Tighten the shared policy's private-group allowance. Keep its root-owned sticky
  // ancestor exception (for example /tmp), which protects owned descendants from replacement.
  for (let parent = dirname(path);;) {
    const entry = lstatSync(parent);
    if ((entry.mode & 0o022) !== 0 && !(entry.uid === 0 && (entry.mode & 0o1000) !== 0))
      refuse("runtime parent is group or world writable");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { path };
}
function withoutPath(source: Buffer): string {
  const text = source.toString("utf8");
  if (!Buffer.from(text).equals(source)) refuse("source is not UTF-8");
  const lines = text.split("\n");
  const matches = lines.filter(line => line.startsWith("Environment=PATH="));
  if (matches.length !== 1 || !/^Environment=PATH="(?:[^"\\\u0000-\u001f\u007f]|\\[\\"])*"$/.test(matches[0]!))
    refuse("source does not have one renderer-shaped PATH line");
  // No systemd parsing: only this one non-execution line may differ. Every other
  // byte must match the renderer, including all execution directives and sections.
  return lines.map(line => line === matches[0] ? "Environment=PATH=<observed>" : line).join("\n");
}

/** Internal local observation only. Equal rereads detect ordinary concurrent changes, not ABA,
 * cross-file atomicity, native registration, or future identity. Revalidate before effects.
 * No publisher authentication, package scope, or signed runtime closure is established here. */
export function installedCoordinate(paths: DaemonPaths, daemonHome?: string) {
  if (process.platform !== "linux" || process.getuid === undefined || process.geteuid === undefined)
    throw new CommandFailure("refused", "UNSUPPORTED", "installed coordinates require Linux");
  const uid = process.getuid();
  if (uid !== process.geteuid()) refuse("real and effective uid differ");
  const state = canonical(paths.state);
  const home = canonical(daemonHome ?? dirname(state));
  if (state !== (daemonHome === undefined ? join(home, "daemon") : home)) refuse("state does not match daemon home");
  protectedLocalDirectory(home);
  protectedLocalDirectory(state);
  const receiptPath = unitReceiptFile(paths);
  const receiptBytes = required(receiptPath, 16 * 1024);
  const receipt = localRecordObject(JSON.parse(receiptBytes.toString("utf8")), ["v", "mechanism", "unit", "unitPath", "unitSha256", "installedAt", "daemonHome"]);
  const directory = canonical(systemdUserUnitDirectory());
  assertSystemdSourceDirectory(directory);
  const unit = daemonUnitName(daemonHome);
  const unitPath = join(directory, unit);
  if (receipt.v !== 1 || (receipt.mechanism !== undefined && receipt.mechanism !== "systemd-user") ||
      receipt.unit !== unit || receipt.unitPath !== unitPath || receipt.daemonHome !== daemonHome ||
      typeof receipt.unitSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.unitSha256) ||
      typeof receipt.installedAt !== "string" || !Number.isFinite(Date.parse(receipt.installedAt)) ||
      new Date(receipt.installedAt).toISOString() !== receipt.installedAt)
    refuse("receipt does not identify this installation");
  canonical(unitPath);
  const source = required(unitPath, 64 * 1024);
  // Compare the same hashed source bytes with the trusted renderer, except its PATH
  // observation. PATH can change between installation and this serving invocation.
  const rendered = renderDaemonUnit(directory, daemonHome);
  if (hash(source) !== receipt.unitSha256 || withoutPath(source) !== withoutPath(Buffer.from(rendered.bytes)))
    refuse("source differs from the receipt or trusted serving invocation");
  const argv = daemonServeArgv(daemonHome);
  const entryIndex = argv.indexOf("daemon") - 1;
  if (entryIndex < 1) refuse("trusted invocation has no entry");
  const executable = fileObservation(argv[0]!, uid);
  const entry = fileObservation(argv[entryIndex]!, uid);
  const manifestPath = join(dirname(dirname(entry.path)), "desktop-runtime.json");
  const manifestBytes = readLocalRecordSource(manifestPath, 1024 * 1024);
  let runtime: { kind: "unpackaged" } | { kind: "local-manifest"; path: string; sha256: string; version: string; target: string; node: string } = { kind: "unpackaged" };
  if (manifestBytes !== undefined) {
    if (entry.path !== join(dirname(manifestPath), "dist", "cotal.js")) refuse("manifest is outside the desktop runtime layout");
    canonical(manifestPath);
    const stat = lstatSync(manifestPath);
    if (stat.uid !== uid || (stat.mode & 0o022) !== 0) refuse("manifest is not owned and protected");
    const manifest = localRecordObject(JSON.parse(manifestBytes.toString("utf8")), ["schema", "version", "target", "node", "files"]);
    if (manifest.schema !== 1 || ![manifest.version, manifest.target, manifest.node].every(v => typeof v === "string" && v.length > 0 && v.length < 256) ||
        !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) ||
        !Object.entries(manifest.files).every(([name, digest]) => name.length > 0 && !isAbsolute(name) && !name.split(/[\\/]/).includes("..") && typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)))
      refuse("manifest is malformed");
    runtime = { kind: "local-manifest", path: manifestPath, sha256: hash(manifestBytes), version: manifest.version as string, target: manifest.target as string, node: manifest.node as string };
  }
  const snapshot = {
    schema: 1 as const, platform: "linux" as const, uid, authentication: "local-installation-only" as const,
    home, state, mechanism: "systemd-user" as const, unit, unitPath,
    receiptSha256: hash(receiptBytes), sourceSha256: hash(source), installedAt: receipt.installedAt,
    invocation: { executable, nodeArguments: argv.slice(1, entryIndex), entry, daemonArguments: argv.slice(entryIndex + 1) }, runtime,
  };
  if (!required(receiptPath, 16 * 1024).equals(receiptBytes) || !required(unitPath, 64 * 1024).equals(source))
    refuse("installation changed during observation");
  const manifestAgain = readLocalRecordSource(manifestPath, 1024 * 1024);
  if (manifestBytes === undefined ? manifestAgain !== undefined : !manifestAgain?.equals(manifestBytes)) refuse("manifest changed during observation");
  return { snapshot, sha256: hash(JSON.stringify(snapshot)) };
}
