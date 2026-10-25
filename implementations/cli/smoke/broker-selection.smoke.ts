/**
 * Which nats-server a broker start runs, and which files it runs to find out. A broker launch refuses
 * an executable that another local account could replace, or that sits in a folder another account
 * could write, as a group-writable Homebrew Cellar on macOS is. Such a file is never run, not even
 * for its version. One on PATH gives way to a bundled one that passes the rule. When neither passes,
 * the PATH one stays the choice with its refusal, status names it, and resolving the broker refuses
 * before anything runs. A protected one on PATH is still the choice, and the version floor holds.
 *
 * Both files are stand-in scripts that append their name to a marks file when they run. A module
 * resolve hook points the bundled platform package at a stand-in package whose getBinaryPath() reads
 * the bundled path from a file, or throws as an absent install does. Broker-free.
 *
 * Run: pnpm smoke:broker-selection
 */
import { strict as nodeAssert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { isCommandFailure } from "@cotal-ai/workspace";
import { findNatsServer, natsServerLabel, natsServerProblem, resolveNatsServer } from "../src/lib/nats-bin.js";
import { machineStatus } from "../src/lib/status.js";

if (process.platform === "win32") skipSuite("the executable protection rule is POSIX-only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-broker-selection-")));
const priorPath = process.env.PATH;
const pathBin = join(base, "path-bin"), bundledBin = join(base, "bundled", "bin"), noBroker = join(base, "no-broker");
const onPath = join(pathBin, "nats-server"), bundled = join(bundledBin, "nats-server");
const marks = join(base, "marks"), bundledPathFile = join(base, "bundled-path");
const stand = (file: string, name: string, version: string): void =>
  writeFileSync(file, `#!/bin/sh\necho '${name}' >> '${marks}'\necho 'nats-server: v${version}'\n`, { mode: 0o755 });
/** The stand-ins that ran since the last call. */
const ran = (): string[] => {
  let text = "";
  try { text = readFileSync(marks, "utf8"); } catch { /* none ran */ }
  rmSync(marks, { force: true });
  return text.split("\n").filter(Boolean);
};
/** The modes of the two folders, whether the bundled package is installed, and PATH. */
const set = (pathMode: number, bundledMode: number | "missing", path = `${pathBin}:${priorPath ?? ""}`): void => {
  chmodSync(pathBin, pathMode);
  chmodSync(bundledBin, bundledMode === "missing" ? 0o755 : bundledMode);
  writeFileSync(bundledPathFile, bundledMode === "missing" ? "" : bundled);
  process.env.PATH = path;
};
const refusal = (run: Promise<unknown>): Promise<unknown> => run.then(() => undefined, (error: unknown) => error);
const unprotected = (what: string, folder: string): string => `${what} is not protected against other local writers: ${folder} is writable by every local account`;
try {
  mkdirSync(pathBin, { mode: 0o755 });
  mkdirSync(bundledBin, { recursive: true, mode: 0o755 });
  mkdirSync(noBroker, { mode: 0o755 });
  stand(onPath, "path", "2.14.0");
  stand(bundled, "bundled", "2.14.0");
  const pkgDir = join(base, "bundled-package");
  mkdirSync(pkgDir, { mode: 0o755 });
  writeFileSync(join(pkgDir, "index.js"), `import { readFileSync } from "node:fs";\nexport function getBinaryPath() {\n  const path = readFileSync(${JSON.stringify(bundledPathFile)}, "utf8");\n  if (!path) throw new Error("not installed");\n  return path;\n}\n`);
  const hook = join(base, "hook.mjs");
  writeFileSync(hook, `export async function resolve(specifier, context, next) {\n  return specifier === ${JSON.stringify(`@eplightning/nats-server-${process.platform}-${process.arch}`)} ? { url: ${JSON.stringify(pathToFileURL(join(pkgDir, "index.js")).href)}, shortCircuit: true } : next(specifier, context);\n}\n`);
  register(pathToFileURL(hook).href);

  set(0o777, 0o755);
  const skipping = await findNatsServer();
  assert.deepEqual({ path: skipping.path, source: skipping.source, version: skipping.version, refused: skipping.refused }, { path: bundled, source: "bundled", version: "2.14.0", refused: undefined }, "a nats-server on PATH in a folder every account can write gives way to a protected bundled one");
  assert.equal(skipping.skipped?.path, onPath, "the one passed over is named");
  assert.equal(skipping.skipped?.reason.slice(0, unprotected("the nats-server on PATH", pathBin).length), unprotected("the nats-server on PATH", pathBin), "with the reason the launch would refuse it");
  assert.deepEqual(ran(), ["bundled"], "only the bundled one ran, for its version");
  assert.equal(natsServerLabel(skipping), `bundled nats-server 2.14.0 at ${bundled}; the one on PATH at ${onPath} is not protected against other local writers, so it was not used`, "its label says the PATH one was not used");

  set(0o755, 0o755);
  assert.deepEqual({ ...await findNatsServer() }, { path: onPath, source: "path", version: "2.14.0" }, "a protected nats-server on PATH is still the choice, with nothing skipped or refused");
  assert.deepEqual(ran(), ["path"], "and only it ran");

  set(0o777, 0o777);
  const neither = await findNatsServer();
  assert.deepEqual({ path: neither.path, source: neither.source, version: neither.version, skipped: neither.skipped }, { path: onPath, source: "path", version: null, skipped: undefined }, "with no protected bundled one, the PATH one stays the choice, with no version");
  assert.deepEqual(ran(), [], "and neither unprotected file ran, not even for its version");
  const problem = natsServerProblem(neither);
  assert.equal(problem, `${neither.refused?.message}; there is no protected bundled nats-server to use instead`, "the problem is the launch's refusal of the PATH one, and says no bundled one can stand in");
  assert.equal(neither.refused?.message.slice(0, unprotected("the nats-server on PATH", pathBin).length), unprotected("the nats-server on PATH", pathBin), "naming the folder");
  const refused = await refusal(resolveNatsServer());
  assert.ok(isCommandFailure(refused) && refused.code === "PERMISSION_DENIED", "resolving the broker refuses PERMISSION_DENIED");
  assert.equal(isCommandFailure(refused) ? refused.message : undefined, `${problem}; nothing was run or started`, "saying nothing was run or started");
  assert.match(isCommandFailure(refused) ? refused.remedy ?? "" : "", /^chmod go-w /, "with the chmod the launch would name");
  assert.deepEqual(await machineStatus(), { nats: "path", natsServer: { path: onPath, version: null }, natsProblem: problem }, "status names why");
  assert.deepEqual(ran(), [], "and resolving and status ran nothing either");

  set(0o777, "missing");
  const missing = await findNatsServer();
  assert.deepEqual({ path: missing.path, source: missing.source, version: missing.version, problem: natsServerProblem(missing) }, { path: onPath, source: "path", version: null, problem }, "with no bundled one installed, the unprotected PATH one is refused the same way");
  assert.deepEqual(ran(), [], "and is not run");

  set(0o755, 0o777, noBroker);
  const bundledOnly = await findNatsServer();
  assert.deepEqual({ path: bundledOnly.path, source: bundledOnly.source, version: bundledOnly.version }, { path: bundled, source: "bundled", version: null }, "with none on PATH, an unprotected bundled one is refused, with no version");
  assert.equal(natsServerProblem(bundledOnly)?.slice(0, unprotected("the bundled nats-server", bundledBin).length), unprotected("the bundled nats-server", bundledBin), "its problem names its folder");
  const bundledRefused = await refusal(resolveNatsServer());
  assert.ok(isCommandFailure(bundledRefused) && bundledRefused.code === "PERMISSION_DENIED", "and resolving the broker refuses it");
  assert.deepEqual(ran(), [], "without running it");

  set(0o755, "missing", noBroker);
  const absent = await refusal(findNatsServer());
  assert.match(absent instanceof Error ? absent.message : "", /^nats-server not found on PATH, and the bundled binary for /, "with neither installed, the lookup still throws naming both");

  stand(onPath, "path", "2.10.0");
  set(0o755, 0o755);
  const old = await refusal(resolveNatsServer());
  assert.ok(isCommandFailure(old) && old.code === "DEPENDENCY_UNAVAILABLE" && old.message === `the nats-server on PATH at ${onPath} reports version 2.10.0, and this stack needs nats-server 2.12 or newer; nothing was started`, "a protected PATH one below the version floor is still refused for its version");
  assert.deepEqual(ran(), ["path"], "after only it ran");
} finally {
  process.env.PATH = priorPath;
  rmSync(base, { recursive: true, force: true });
}

console.log("broker-selection smoke: OK - a nats-server that fails the launch rule is never run; a protected bundled one stands in for it, and with none the start refuses naming the fix");
emitSentinel({ passed: counted.cells(), failed: 0 });
