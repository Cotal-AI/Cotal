import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hermesUvCommand } from "./binary.js";
import type { ListenBridgePipe } from "./bridge.js";
import type { startSidecar } from "./sidecar.js";

/** Private launcher interface, supplied by the CLI only for native Windows foreground seats. */
export interface WindowsHost {
  startProcess(program: string, args: string[], env: NodeJS.ProcessEnv, log: string): {
    exited: Promise<number>;
    stop(): Promise<void>;
  };
  listenOwnerPipe: ListenBridgePipe;
}

const STOP_SIGNALS = ["SIGINT", "SIGHUP", "SIGBREAK", "SIGTERM"] as const;

export async function runWindowsGateway(pkgDir: string, env: NodeJS.ProcessEnv, root: string, startProcess: WindowsHost["startProcess"], start: (onShutdown: () => void) => ReturnType<typeof startSidecar>, reclaim: () => void): Promise<void> {
  let gateway: ReturnType<typeof startProcess> | undefined;
  let requestStop!: () => void;
  const stop = new Promise<void>((resolve) => { requestStop = resolve; });
  let sidecar: ReturnType<typeof startSidecar> | undefined;
  const readiness = new AbortController();
  for (const signal of STOP_SIGNALS) process.on(signal, requestStop);
  try {
    sidecar = start(requestStop);
    delete env.COTAL_HERMES_PROMPT;
    if (env.HERMES_INFERENCE_PROVIDER === "custom" && env.CUSTOM_BASE_URL) delete env.CUSTOM_API_KEY;
    gateway = startProcess(hermesUvCommand(env), ["run", "--project", pkgDir, "hermes", "gateway", "run"], env, join(root, "gateway.log"));
    const ended = Promise.race([gateway.exited, stop.then(() => undefined)]);
    const initial = await Promise.race([ended, awaitReady(sidecar.agent, readiness.signal)]).finally(() => readiness.abort());
    if (typeof initial === "number") throw new Error(`Hermes gateway exited before the seat was ready (exit ${initial})`);
    const code = initial === "ready" ? await ended : undefined;
    if (code === undefined) {
      sidecar.shutdownGateway();
      await Promise.race([gateway.exited, delay(1_500)]);
    }
    process.exitCode = code ?? 0;
  } finally {
    try {
      let drained = false;
      try { await gateway?.stop(); drained = true; }
      finally {
        if (sidecar) await sidecar.stop(drained ? reclaim : undefined);
        else if (drained) reclaim();
      }
    } finally {
      for (const signal of STOP_SIGNALS) process.off(signal, requestStop);
    }
  }
}

async function awaitReady(agent: ReturnType<typeof startSidecar>["agent"], signal: AbortSignal): Promise<"ready"> {
  const deadline = Date.now() + 90_000;
  while (agent.connectionState !== "ready") {
    if (Date.now() >= deadline) throw new Error("Hermes did not authenticate its bridge and join the mesh within 90 seconds");
    await delay(100, undefined, { signal });
  }
  return "ready";
}
