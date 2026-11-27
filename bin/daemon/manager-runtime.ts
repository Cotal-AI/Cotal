import { Worker } from "node:worker_threads";

/** Both hosted Managers and their PTY hosts use the same verified, retained app runtime. */
export function retainHostedAppRuntime(home: string, source: string, preserveNodeQuarantine = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./manager-runtime-worker.js", import.meta.url), { workerData: { home, source, preserveNodeQuarantine }, execArgv: [] });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`desktop Manager runtime worker exited without a result (${code})`)));
  });
}
