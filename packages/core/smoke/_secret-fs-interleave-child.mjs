/**
 * Child for the between-check-and-write interleave (see secret-fs.smoke.ts).
 *
 * Runs against the BUILT package rather than the source, because the interleave is installed by an
 * `fs` preload and must reach the exact binding the shipped module uses. Prints one JSON line so
 * the parent asserts on observations rather than on this child's opinion.
 */
import { readdirSync, readFileSync } from "node:fs";

const target = process.env.COTAL_SECRETFS_INTERLEAVE_TARGET;
const dist = process.env.COTAL_SECRETFS_INTERLEAVE_DIST;
const mod = await import(dist);

let code;
try {
  mod.writeSecretFileCreateOnly(target, "latecomer\n");
} catch (e) {
  code = e.code;
}
let bytes;
try {
  bytes = readFileSync(target, "utf8");
} catch {
  try {
    const dir = target.slice(0, target.lastIndexOf("/"));
    const squatted = readdirSync(dir).find((n) => n.startsWith("contested.secret") && n.endsWith(".tmp"));
    bytes = squatted ? readFileSync(`${dir}/${squatted}`, "utf8") : "\u0000ABSENT";
  } catch {
    bytes = "\u0000ABSENT";
  }
}
process.stdout.write(`${JSON.stringify({ code, bytes })}\n`);
