import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  localProcessPath,
  removeMeshesByRoot,
  type LocalProcess,
  type LocalProcessContext,
} from "@cotal-ai/workspace";
import { extensionNames, localProcessSurface } from "../ext-loader.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";
import { downManifest } from "./down-manifest.js";

/** Complete selective component names without importing installed packages. */
export function downComplete(argv: string[]): CompletionResult {
  if (argv.some((word) => word === "-f" || word === "--file" || word === "--run"))
    return { items: [], directive: "nofiles" };
  if ((argv[argv.length - 1] ?? "").startsWith("-")) return { items: [], directive: "nofiles" };
  const used = new Set(argv.slice(0, -1).filter((word) => !word.startsWith("-")));
  return {
    items: extensionNames("local-process").filter((name) => !used.has(name)).map((value) => ({ value })),
    directive: "nofiles",
  };
}

/** Stop the whole local stack by default, or only named self-registered process components. The
 *  manifest forms remain ownership-scoped deploy teardown and cannot be mixed with components. */
export async function down(args: ParsedArgs): Promise<void> {
  const values = args.values as { file?: string; run?: string; "dry-run"?: boolean };
  const requested = [...new Set(args.positionals)];
  if ((values.file || values.run) && requested.length) {
    throw new Error("component names cannot be combined with --file or --run");
  }
  if (values.file || values.run) {
    await downManifest(values.file ?? "<run>", { run: values.run, dryRun: Boolean(values["dry-run"]) });
    return;
  }
  const all = localProcessSurface();
  const known = all.map((component) => component.name).sort();
  const unknown = requested.filter((name) => !known.includes(name));
  if (unknown.length)
    throw new Error(`unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => JSON.stringify(name)).join(", ")} - known: ${known.join(", ")}`);
  const selected = (requested.length ? requested.map((name) => all.find((part) => part.name === name)!) : all)
    .sort((a, b) => Number(Boolean(a.stopLast)) - Number(Boolean(b.stopLast)) || (a.order ?? 50) - (b.order ?? 50));
  const context: LocalProcessContext = { root: cotalRoot(), space: resolveSpace(process.cwd()) };

  if (selected.some((component) => component.stopLast)) {
    const selectedNames = new Set(selected.map((component) => component.name));
    const dependants = all.filter((component) => !selectedNames.has(component.name) && processAlive(component, context));
    if (dependants.length) {
      throw new Error(
        `cannot stop ${selected.filter((component) => component.stopLast).map((component) => component.name).join(", ")} while ${dependants.map((component) => component.name).join(", ")} ${dependants.length === 1 ? "is" : "are"} still running - name them too, or run bare \`cotal down\``,
      );
    }
  }

  if (values["dry-run"]) {
    const recorded = selected.filter((component) => processRecorded(component, context));
    for (const component of recorded) console.log(c.dim(`would stop ${component.label}`));
    if (!recorded.length) {
      const target = requested.length ? requested.join(", ") : "the local stack";
      console.error(c.red(`Nothing running for ${target} (no recorded pidfiles).`));
      process.exit(1);
    }
    console.log(c.dim("Dry run - nothing was changed. Re-run without --dry-run to stop these components."));
    return;
  }

  let any = false;
  for (const component of selected) any = (await stop(component, context)) || any;

  // The broker owns the mesh registry entry and transient whole-mesh launch material. Selective
  // control-plane shutdown leaves both intact so `cotal up` can heal only what was stopped.
  if (selected.some((component) => component.clearsMesh)) {
    rmSync(join(context.root, ".cotal", "run"), { recursive: true, force: true });
    removeMeshesByRoot(context.root);
  }
  if (!any) {
    const target = requested.length ? requested.join(", ") : "the local stack";
    console.error(c.red(`Nothing running for ${target} (no recorded pidfiles).`));
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parsePid = (raw: string): number | undefined => {
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};
export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

function processRecorded(component: LocalProcess, context: LocalProcessContext): boolean {
  return existsSync(localProcessPath(component.pidFile, context)) || (component.artifacts ?? []).map((artifact) => localProcessPath(artifact, context)).some(existsSync);
}

function processAlive(component: LocalProcess, context: LocalProcessContext): boolean {
  const pidPath = localProcessPath(component.pidFile, context);
  if (!existsSync(pidPath)) return false;
  const pid = parsePid(readFileSync(pidPath, "utf8"));
  return pid !== undefined && isAlive(pid);
}

/** Stop one recorded process and await its actual exit before the next dependency is stopped. */
async function stop(component: LocalProcess, context: LocalProcessContext): Promise<boolean> {
  const pidPath = localProcessPath(component.pidFile, context);
  const artifacts = (component.artifacts ?? []).map((artifact) => localProcessPath(artifact, context));
  const found = processRecorded(component, context);
  if (!existsSync(pidPath)) {
    for (const artifact of artifacts) rmSync(artifact, { force: true });
    return found;
  }

  const rawPid = readFileSync(pidPath, "utf8").trim();
  if (rawPid.startsWith("removing:")) {
    const owner = parsePid(rawPid.slice("removing:".length));
    throw new Error(
      owner && isAlive(owner)
        ? `${component.name} extension removal is in progress (pid ${owner})`
        : `${component.name} has a stale extension-removal reservation at ${pidPath} - remove that file and retry`,
    );
  }
  const pid = parsePid(rawPid);
  const marker = `${pidPath}.stopping`;
  let markerFd: number | undefined;
  for (;;) {
    try {
      markerFd = openSync(marker, "wx", 0o600);
      writeFileSync(markerFd, String(process.pid));
      break;
    } catch (e) {
      if (markerFd !== undefined) {
        closeSync(markerFd);
        rmSync(marker, { force: true });
        markerFd = undefined;
      }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number | undefined;
      try {
        owner = parsePid(readFileSync(marker, "utf8"));
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readErr;
      }
      if (owner && isAlive(owner))
        throw new Error(`${component.name} is already being stopped by another \`cotal down\` (pid ${owner})`);
      // A dead owner cannot finish cleanup. Reclaim its marker and retry the exclusive create.
      rmSync(marker, { force: true });
    }
  }
  closeSync(markerFd);

  let stopped = false;
  try {
    if (pid === undefined) {
      console.log(c.dim(`${component.label} had an invalid pidfile.`));
      stopped = true;
      return true;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      if (isAlive(pid)) throw new Error(`could not signal ${component.label} (pid ${pid})`);
      console.log(c.dim(`${component.label} (pid ${pid}) was not running.`));
      stopped = true;
      return true;
    }
    const graceDeadline = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < graceDeadline) await sleep(100);
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
      const hardDeadline = Date.now() + 3_000;
      while (isAlive(pid) && Date.now() < hardDeadline) await sleep(100);
    }
    if (isAlive(pid)) throw new Error(`${component.label} (pid ${pid}) did not exit; its pidfile was preserved`);
    stopped = true;
    console.log(c.green(`✓ stopped ${component.label} (pid ${pid})`));
    return true;
  } finally {
    if (stopped || pid === undefined || !isAlive(pid)) {
      rmSync(pidPath, { force: true });
      for (const artifact of artifacts) rmSync(artifact, { force: true });
    }
    rmSync(marker, { force: true });
  }
}

/** Compatibility inventory for `clean`; lifecycle commands use the registered descriptors above. */
export function pidfileTargets(space: string): Array<[file: string, label: string]> {
  return [
    ["manager.pid", "manager"],
    ["delivery.pid", "delivery daemon"],
    [`auth-service.${encodeURIComponent(space)}.pid`, "user-auth service"],
    ["web.pid", "web dashboard"],
    ["nats.pid", "nats-server"],
  ];
}

export type PidfileState = { pid?: number; live: boolean; note?: string };

/** Shared hardened pid probe: positive integers only, and EPERM means the process exists. */
export function pidfileState(path: string): PidfileState {
  if (!existsSync(path)) return { live: false, note: "no pidfile" };
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("removing:")) return { live: false, note: "extension removal in progress" };
  const pid = parsePid(raw);
  if (!pid) return { live: false, note: "bad pidfile" };
  return isAlive(pid) ? { pid, live: true } : { pid, live: false, note: "stale pidfile" };
}
