/**
 * The lifecycle hook stays light. Claude Code starts `dist/hook.cjs` as a new process for every tool
 * call, prompt and stop, in every session the plugin is enabled for, so whatever the bundle loads is
 * paid each time. One root import of `@cotal-ai/core` (to print a peer label) once pulled the whole
 * barrel in, with YAML and NATS behind it: a 945 KB bundle that took about 80 ms a run against 30 ms
 * for bare node. This bundles the hook with the flags the package's `bundle` script uses and asserts
 * it reaches neither the barrel nor those dependencies.
 *
 * Run: pnpm smoke:claude-hook-weight
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
const { metafile } = await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  metafile: true,
  logLevel: "silent",
});
const inputs = Object.keys(metafile.inputs);

let checks = 0;
function ok(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

console.log("hook-weight.smoke:");
ok("the bundle is built from the shipped hook entry", () => assert.ok(inputs.some((path) => path.endsWith("src/hook.ts")), inputs.join("\n")));
ok("the hook does not load the @cotal-ai/core barrel", () => {
  assert.deepEqual(inputs.filter((path) => /packages\/core\/dist\/index\.js$|@cotal-ai\/core\/dist\/index\.js$/.test(path)), []);
});
ok("the hook bundles no YAML or NATS module", () => {
  assert.deepEqual(inputs.filter((path) => /node_modules\/(yaml|@nats-io)\//.test(path)), []);
});
console.log(`hook-weight.smoke: ${checks} checks passed`);
