import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "@cotal-ai/workspace";
import { hermesUvCommand } from "./binary.js";
import type { startSidecar } from "./sidecar.js";

export async function runWindowsGateway(pkgDir: string, env: NodeJS.ProcessEnv, root: string, start: (onShutdown: () => void) => ReturnType<typeof startSidecar>): Promise<void> {
  let gateway: ReturnType<typeof startWindowsGateway> | undefined;
  let requestStop!: () => void;
  const stop = new Promise<void>((resolve) => { requestStop = resolve; });
  const sidecar = start(requestStop);
  const readiness = new AbortController();
  process.on("SIGINT", requestStop);
  try {
    delete env.COTAL_HERMES_PROMPT;
    if (env.HERMES_INFERENCE_PROVIDER === "custom" && env.CUSTOM_BASE_URL) delete env.CUSTOM_API_KEY;
    gateway = startWindowsGateway(pkgDir, env, root);
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
    process.off("SIGINT", requestStop);
    try { await gateway?.stop(); } finally { await sidecar.stop(); }
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

export function startWindowsGateway(pkgDir: string, env: NodeJS.ProcessEnv, root: string): {
  exited: Promise<number>;
  stop(): Promise<void>;
} {
  const job = win32ProcessBinding();
  const path = join(root, "gateway.log");
  const fd = openSync(path, "wx+");
  const program = hermesUvCommand(env);
  try {
    job.launch({ application: program, commandLine: windowsCommandLine(program, ["run", "--project", pkgDir, "hermes", "gateway", "run"]),
      cwd: process.cwd(), environment: windowsEnvironmentBlock(env), log: path });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let pos = 0;
  const data = Buffer.alloc(8192);
  const output = (): void => {
    let n: number;
    while ((n = readSync(fd, data, 0, data.length, pos)) > 0) {
      pos += n;
      process.stderr.write(Buffer.from(data.subarray(0, n)));
    }
  };
  let stopping = false;
  const exited = (async () => {
    for (;;) {
      if (stopping) return 1;
      output();
      const code = job.rootExit();
      if (code !== undefined) return code;
      await delay(100);
    }
  })();
  return {
    exited,
    async stop() {
      stopping = true;
      try {
        while (job.drain(1_000) !== "drained") await delay(100);
        await exited;
        output();
      } finally { closeSync(fd); }
    },
  };
}
