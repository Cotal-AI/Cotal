#!/usr/bin/env node
/**
 * Decide whether a release version installs from the registry and runs, before it is announced.
 *
 * The closure gate (`verify-publish-closure.mjs`) proves every package in the fixed group answers on
 * its per-version endpoint. npm install resolves through the packument, which can lag that endpoint,
 * so a version can pass the closure gate while `npm i -g cotal-ai@<version>` fails with ETARGET on a
 * pinned sibling. On 0.48.2 that hole stayed open for about five minutes (#1412). Presence is not
 * installability, so this gate installs `cotal-ai@<version>` into a scratch prefix with a fresh cache
 * and runs the installed `cotal --version`.
 *
 * A failed attempt before the deadline is UNKNOWN, not a failure: the registry may still be
 * converging. The gate polls until an attempt succeeds or the deadline passes. The deadline also
 * bounds each attempt: npm and the binary are killed when it passes, so a registry that accepts a
 * request and never answers cannot hold the gate open past it.
 *
 * Usage:  node scripts/verify-release-installable.mjs <version>
 *           [--registry=<url>] [--poll-interval-ms=<n>] [--deadline-ms=<n>]
 * Exit:   0 INSTALLABLE      the install succeeded and the binary reported the version
 *         1 NOT INSTALLABLE  no attempt succeeded before the deadline
 *         64                 usage error
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainEntry } from "./main-entry.mjs";

export const DEFAULTS = {
  registry: "https://registry.npmjs.org",
  pollIntervalMs: 15_000,
  deadlineMs: 10 * 60_000,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, version: "" };
  const numeric = { "--poll-interval-ms": "pollIntervalMs", "--deadline-ms": "deadlineMs" };
  for (const arg of argv) {
    const [flag, raw] = arg.split(/=(.*)/s);
    if (!flag.startsWith("--")) {
      if (opts.version) throw new Error(`unexpected argument ${arg}`);
      opts.version = arg;
    } else if (flag === "--registry" && raw) {
      opts.registry = raw.replace(/\/+$/, "");
    } else if (numeric[flag] && /^\d+$/.test(raw ?? "")) {
      opts[numeric[flag]] = Number(raw);
    } else {
      throw new Error(`unknown or malformed flag ${arg}`);
    }
  }
  if (!opts.version) throw new Error("a version is required");
  return opts;
}

/** One scratch-prefix install plus a run of the installed binary. Returns null on success. */
function attempt({ version, registry }, deadline) {
  const root = mkdtempSync(join(tmpdir(), "cotal-installable-"));
  try {
    // An empty user and global config keeps an operator's .npmrc (auth, a mirror, a pinned
    // registry) out of the answer; a fresh cache keeps a stale packument out of it.
    writeFileSync(join(root, "user.npmrc"), "");
    writeFileSync(join(root, "global.npmrc"), "");
    const env = {
      ...process.env,
      npm_config_userconfig: join(root, "user.npmrc"),
      npm_config_globalconfig: join(root, "global.npmrc"),
      npm_config_cache: join(root, "cache"),
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const bounded = () => ({ cwd: root, env, encoding: "utf8", killSignal: "SIGKILL", timeout: Math.max(1, deadline - Date.now()) });
    const prefix = join(root, "prefix");
    const install = spawnSync(
      "npm",
      ["install", "-g", "--prefix", prefix, `--registry=${registry}/`, `cotal-ai@${version}`],
      bounded(),
    );
    if (install.error?.code === "ETIMEDOUT") return "npm install was killed at the deadline";
    if (install.status !== 0) {
      const why = `${install.stderr}${install.stdout}`.split("\n").filter((l) => l.startsWith("npm error")).slice(0, 4);
      return `npm install exited ${install.status}${why.length ? `: ${why.join(" | ")}` : ""}`;
    }
    const run = spawnSync(join(prefix, "bin", "cotal"), ["--version"], bounded());
    if (run.error?.code === "ETIMEDOUT") return "cotal --version was killed at the deadline";
    const first = (run.stdout ?? "").split("\n")[0].trim();
    if (run.status !== 0 || first !== `cotal-ai ${version}`) {
      return `cotal --version exited ${run.status} and printed ${JSON.stringify(first)}`;
    }
    return null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function verifyInstallable(opts, log = (line) => process.stdout.write(`${line}\n`)) {
  const deadline = Date.now() + opts.deadlineMs;
  for (let n = 1; ; n++) {
    const failure = attempt(opts, deadline);
    if (failure === null) {
      log(`VERDICT: INSTALLABLE: cotal-ai@${opts.version} installed and ran (attempt ${n}).`);
      return 0;
    }
    log(`attempt ${n}: ${failure}`);
    if (Date.now() + opts.pollIntervalMs > deadline) {
      log(`VERDICT: NOT INSTALLABLE: cotal-ai@${opts.version} did not install and run before the deadline.`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
}

if (isMainEntry(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: verify-release-installable.mjs <version> [--registry=<url>] [--poll-interval-ms=<n>] [--deadline-ms=<n>]\n`);
    process.exit(64);
  }
  verifyInstallable(opts).then((code) => process.exit(code));
}
