import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./endpoint.js";
import { admitDarwinSeatHost, darwinSeatHostGenerationRoot, darwinSeatHostSocket, planDarwinSeatHost, type DarwinSeatHostScope } from "./seat-host-darwin.js";

const entrySuffix = "dist/daemon/seat-host-entry-darwin.js";
const entryPath = fileURLToPath(import.meta.url);

/** Resolve the execution entry from the protected runtime, not the replaceable installation. */
export async function prepareDarwinDesktopHost(scope: DarwinSeatHostScope, runtimeRoot: string) {
  const { retainDarwinSeatRuntime } = await import("./seat-runtime-darwin.js");
  const retained = await retainDarwinSeatRuntime({ home: scope.cotalHome, installedRoot: scope.installedRoot,
    node: process.execPath, root: runtimeRoot, entry: join(runtimeRoot, entrySuffix), desktop: true });
  const { generation } = retained;
  return { generation, root: darwinSeatHostGenerationRoot(scope, generation),
    plan: planDarwinSeatHost({ ...scope, generation,
      argv: [retained.node, retained.entry, scope.cotalHome, scope.installedRoot, scope.space, generation,
        ...(scope.daemonHome === undefined ? [] : [scope.daemonHome])],
    }),
  };
}

async function runHostEntry(): Promise<void> {
  const [node, entry, cotalHome, installedRoot, space, generation, daemonHome, ...extra] = process.argv;
  if (process.platform !== "darwin" || extra.length || !cotalHome || !installedRoot || !space ||
      !generation || !/^[a-f0-9]{64}$/.test(generation))
    throw new Error("invalid Darwin PTY host entry");
  const retained = join(cotalHome, "daemon", "app-manager-runtimes", generation);
  if (node !== join(retained, "cotal-node") || entry !== join(retained, "runtime", entrySuffix) ||
      process.execPath !== node || realpathSync.native(node) !== node || realpathSync.native(entry) !== entry)
    throw new Error("unverified retained Darwin PTY host entry");
  const scope = { cotalHome, ...(daemonHome === undefined ? {} : { daemonHome }), installedRoot, space };
  const plan = planDarwinSeatHost({ ...scope, generation,
    argv: [node, entry, cotalHome, installedRoot, space, generation, ...(daemonHome === undefined ? [] : [daemonHome])],
  });
  admitDarwinSeatHost(plan);
  const socket = darwinSeatHostSocket(plan.id);
  const seatEntry = new URL("./shared-host-darwin.js", import.meta.resolve("@cotal-ai/seat"));
  const modulePath = fileURLToPath(seatEntry);
  const seatRelative = relative(join(retained, "runtime"), modulePath);
  if (!seatRelative || seatRelative === ".." || seatRelative.startsWith(`..${sep}`) || isAbsolute(seatRelative) ||
      realpathSync.native(modulePath) !== modulePath || !lstatSync(modulePath).isFile())
    throw new Error("unverified retained Darwin PTY host module");
  const root = darwinSeatHostGenerationRoot(scope, generation);
  const lineage = dirname(root);
  for (const dir of [dirname(lineage), lineage, root]) ensureDir(dir);
  const { serveDarwinSharedHost } = await import(seatEntry.href) as {
    serveDarwinSharedHost(root: string, generation: string, scope: string, socket: string): Promise<void>;
  };
  await serveDarwinSharedHost(root, generation, plan.label, socket);
}

if (process.argv[1] === entryPath) void runHostEntry().catch(error => {
  try { console.error("Darwin PTY host:", error); }
  finally { process.exitCode = 1; }
});
