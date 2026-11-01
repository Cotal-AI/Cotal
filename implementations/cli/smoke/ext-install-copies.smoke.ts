/** Real npm removal and failed-add cleanup must preserve copied file-based extensions.
 * Uses the built CLI and Claude connector in private prefixes; never starts a connector or broker.
 * Build the workspace first. Run: pnpm smoke:ext-install-copies
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

// The pinned-name helper is used by setup/update. A new failed candidate takes its
// npm-remove restore arm, rather than the staged ordinary-add or existing-package snapshot arm.
if (process.argv[2] === "--restore") {
  const { addExtension } = await import("../dist/commands/ext.js");
  await addExtension(process.argv[3]!, process.argv[4]!);
} else {
  const repo = resolve(import.meta.dirname, "../../..");
  const binary = join(repo, "bin", "dist", "cotal.js");
  const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  const source = join(repo, "extensions", "connector-claude-code");
  const keptName = "@cotal-ai/connector-claude-code";
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceDigest = digest(join(source, "dist", "index.js"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-copies-")));
  let passed = 0, failed = 0;
  const check = (name: string, value: boolean): void => {
    if (value) passed++; else failed++;
    console.log(`  ${value ? "✓" : "✗"} ${name}`);
  };
  try {
    for (const arm of ["remove", "restore"] as const) {
      const dir = join(root, arm);
      const home = join(dir, "home");
      const xdg = join(dir, "xdg");
      mkdirSync(join(dir, ".cotal"), { recursive: true });
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(xdg, { mode: 0o700 });
      for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(dir, file), "");
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"),
        TMPDIR: dir, TMP: dir, TEMP: dir, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
        npm_config_cache: join(dir, "npm-cache"), npm_config_userconfig: join(dir, "user.npmrc"),
        npm_config_globalconfig: join(dir, "global.npmrc"), npm_config_update_notifier: "false",
      };
      const child = (args: string[]) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 180_000 });
      const cli = (args: string[]) => child([binary, ...args]);
      const added = cli(["ext", "add", source]);
      assert.equal(added.status, 0, `${arm}: stock connector install failed: ${added.stderr.slice(-800)}`);
      const prefix = join(xdg, "cotal", "extensions");
      const kept = join(prefix, "node_modules", "@cotal-ai", "connector-claude-code");
      check(`${arm}: built-in starts as a copy`, !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      const before = digest(join(kept, "dist", "index.js"));
      check(`${arm}: installed bytes match built source`, before === sourceDigest);
      const siblingName = `cotal-ext-copy-${arm}`;
      const sibling = join(dir, siblingName);
      mkdirSync(sibling);
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: siblingName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      writeFileSync(join(sibling, "index.js"), arm === "remove"
        ? `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "copy-sibling", summary: "fixture", run: async () => {} });\n`
        : "export {};\n");
      if (arm === "remove") {
        const installed = cli(["ext", "add", sibling]);
        assert.equal(installed.status, 0, installed.stderr.slice(-800));
        check("remove: adding a sibling preserves the built-in copy", !lstatSync(kept).isSymbolicLink());
        const removed = cli(["ext", "remove", siblingName]);
        check("remove: the real command succeeds", removed.status === 0);
      } else {
        const refused = child([tsx, fileURLToPath(import.meta.url), "--restore", sibling, siblingName]);
        check("restore: failure reaches the no-registration refusal", refused.status === 1 && /registered no extensions/.test(refused.stderr));
      }
      check(`${arm}: unrelated built-in remains a copy`, !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      check(`${arm}: unrelated built-in bytes are unchanged`, digest(join(kept, "dist", "index.js")) === before);
      check(`${arm}: operated package is absent`, !existsSync(join(prefix, "node_modules", siblingName)));
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check(`${arm}: manifest keeps only the built-in`, manifest.extensions.length === 1 && manifest.extensions[0]?.pkg === keptName);
      check(`${arm}: source package remains unchanged`, digest(join(source, "dist", "index.js")) === sourceDigest);
      check(`${arm}: retained core peer matches the running CLI`, realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === realpathSync(join(repo, "packages", "core")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(passed + failed, 19, "all expected copy/rollback checks ran");
  console.log(`ext-install-copies smoke: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exit(failed ? 1 : 0);
}
