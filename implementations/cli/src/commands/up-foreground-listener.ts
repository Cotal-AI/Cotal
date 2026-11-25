import type { ChildProcess } from "node:child_process";
import { clearCurrent, codeSpan, exitCode, findMesh, getCurrent, keepsRegistration, NATS_PIDFILE, removeMesh, removePidPair } from "@cotal-ai/workspace";
import { stopAuthService } from "../lib/auth-proc.js";
import { stopDelivery } from "../lib/delivery-proc.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { exitInterrupted } from "../lib/interrupt-notice.js";
import { clearManagerArtifacts, stopManager } from "../lib/manager-proc.js";
import type { NatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { restoreInterruptNotice, type PreparedRestore } from "../lib/restore.js";
import { c, stderrLine } from "../ui.js";
import { failedListeners, listenerExitRemedy } from "./up-detach.js";

type StopSignal = "SIGINT" | "SIGTERM";

export function holdForegroundListener({ child, server, space, executable, log, resuming, restored, releaseStartupLock }: {
  child: ChildProcess;
  server: string;
  space: string;
  executable: NatsServer;
  log: string;
  resuming: boolean;
  restored: PreparedRestore | undefined;
  releaseStartupLock: () => void;
}) {
  let listenerReady = false;
  let activationFinished = !resuming;
  let stopSignal: StopSignal | undefined;
  let stoppedListener = false;
  let teardown: Promise<void> | undefined;
  let publishing: Promise<unknown> | undefined;
  let listenerCleanup: Promise<void> | undefined;
  const listenerExited = () => child.exitCode !== null || child.signalCode !== null;

  // The manager must be able to spare its seats. If its guarded stop refuses, leave the rest
  // of the stack running so the operator can choose whether to stop it with its agents.
  const stop = (signal: StopSignal) => {
    if (stopSignal) return;
    stopSignal = signal;
    // Once the broker has exited its handler already owns daemon cleanup.
    if (listenerExited()) return;
    teardown = (async () => {
      // On restore, do not retire the control plane while startup can still publish its processes.
      if (publishing) await publishing.catch(() => {});
      try {
        await stopManager(space);
        clearManagerArtifacts(space);
      } catch (error) {
        console.error(c.red(`! teardown: ${(error as Error).message}`));
        console.error(c.red(`the stack is still running; to take managed agents with it, run: \`cotal down --with-agents\``));
        stopSignal = undefined;
        return;
      }
      await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
      await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
      stoppedListener = child.kill("SIGTERM");
    })();
  };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  restored?.releaseInterruptNotice?.();
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    if (!resuming) process.exit(1);
  });
  child.once("exit", (code, signal) => {
    listenerCleanup = (async () => {
      const launchStoppedListener = failedListeners.has(child);
      if (!launchStoppedListener || stoppedListener) {
        removePidPair(cotalPath(NATS_PIDFILE), String(child.pid));
        await teardown;
        await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
        await stopManager(space).then(() => clearManagerArtifacts(space)).catch((e: Error) => console.error(`! manager teardown: ${e.message}`));
        await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
        if (stopSignal) unrecordListener(space, server);
      }
      if (restored && stoppedListener && stopSignal && !activationFinished) {
        const notice = restoreInterruptNotice(restored.root, restored.attemptId);
        releaseStartupLock();
        exitInterrupted(stopSignal, notice);
      }
      if (launchStoppedListener) return;
      if (stopSignal) {
        if (activationFinished) process.exit(stopSignal === "SIGTERM" ? 143 : 130);
      } else if (code === 0) {
        // External `down` owns its own registry cleanup. Startup reports an early exit itself.
        if (listenerReady && activationFinished) process.exit(0);
      } else {
        reportListenerCrash(space, server, executable, log, code, signal);
        if (activationFinished) process.exit(exitCode("failed", "OPERATION_FAILED"));
      }
    })();
  });

  async function waitForRestoreStop(): Promise<void> {
    await teardown;
    if (!stoppedListener) return;
    if (!listenerCleanup) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await listenerCleanup;
  }

  return {
    isStopping: () => stopSignal !== undefined,
    listenerReady: () => { listenerReady = true; },
    activationFinished: () => { activationFinished = true; },
    publishControlPlane<T>(publish: () => Promise<T>): Promise<T> {
      const ready = publish();
      if (restored) publishing = ready;
      return ready;
    },
    // If startup also fails while our stop is in flight, let teardown prove who stopped the
    // listener before reporting the result. A refused stop leaves the original outcome in charge.
    waitForRestoreStop: () => restored && stopSignal ? waitForRestoreStop() : undefined,
  };
}

function unrecordListener(space: string, server: string): void {
  // A newer registration or a manually registered mesh does not belong to this listener.
  const mine = findMesh(space);
  if (mine && mine.origin !== "manual" && mine.server === server && mine.root === cotalRoot() && !keepsRegistration(mine)) {
    removeMesh(space);
    if (getCurrent() === space) clearCurrent();
  }
}

function reportListenerCrash(space: string, server: string, executable: NatsServer, log: string, code: number | null, signal: NodeJS.Signals | null): void {
  const detail = signal ? `signal ${signal}` : `code ${code}`;
  const repair = `log: see ${log}; repair: ${codeSpan(`cotal up --server ${shellWord(server)} --space ${shellWord(space)}`)}`;
  let outcome: string;
  try {
    const mine = findMesh(space);
    outcome = mine && mine.server === server && mine.root === cotalRoot()
      ? `; the mesh "${space}" stays recorded (\`cotal meshes\` lists it offline); ${repair}`
      : ` before the mesh "${space}" was recorded; next: ${listenerExitRemedy(executable, log)}`;
  } catch {
    outcome = `; whether the mesh "${space}" stays recorded could not be read; ${repair}`;
  }
  stderrLine("✗ ", `nats-server exited unexpectedly (${detail})${outcome}`, c.red);
}
