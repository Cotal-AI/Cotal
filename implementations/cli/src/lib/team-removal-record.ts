import { closeSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realDirNoSymlink, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { protectedLocalDirectory } from "@cotal-ai/workspace";

const MAX_BYTES = 256 * 1024;

/** The original root's real, protected control directory. Removal records never fall back elsewhere. */
export function removalRecordDirectory(root: string): string {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("team removal needs the original real control directory");
  protectedLocalDirectory(dir);
  return dir;
}

/** A private, owned, bounded regular file; anything else stays unreadable rather than absent. */
export function readRemovalRecord(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("removal record is not private, owned and bounded");
  const body = readFileSync(path);
  if (body.length > MAX_BYTES) throw new Error("removal record exceeds its bound");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

/** Create-only and synced with its directory before any later native effect relies on it. */
export function publishRemovalRecord(root: string, name: string, value: unknown): void {
  const dir = removalRecordDirectory(root), body = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("removal record exceeds its bound");
  const path = join(dir, name);
  writeSecretFileCreateOnly(path, body);
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const parent = openSync(dir, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
