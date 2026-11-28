import { createServer } from "node:net";
import { brokerAddressKey, codeSpan, CommandFailure, loadMeshes } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";

/** Choose an unreserved local address for an implicit start or a retry suggestion.
 * The broker still validates and binds its own listener; this inspection cannot reserve the port. */
export async function freshStackServer(server: string, bindHost?: string): Promise<string> {
  const url = new URL(server);
  const host = (bindHost ?? url.hostname).replace(/^\[|\]$/g, "");
  const reserved = new Set<string>();
  for (const mesh of loadMeshes()) {
    const key = brokerAddressKey(mesh.server);
    if (key !== undefined) reserved.add(key);
  }
  let candidate = server;
  for (let attempt = 0; attempt < 16; attempt++) {
    const address = new URL(candidate);
    const key = brokerAddressKey(candidate);
    if (key === undefined || !reserved.has(key)) {
      try {
        await freePort(host, Number(address.port) || 4222);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    candidate = await serverWithFreePort(server, host);
  }
  throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no unreserved local broker address could be selected; no broker was started");
}

export async function serverWithFreePort(server: string, host: string): Promise<string> {
  const url = new URL(server);
  url.port = String(await freePort(host));
  return url.toString();
}

export function freePort(host: string, requestedPort = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(requestedPort, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : undefined;
      srv.close((err) => {
        if (err) reject(err);
        else if (port) resolve(port);
        else reject(new Error("could not allocate a free port"));
      });
    });
  });
}

/** Only replay switches that cannot carry local values. Other invocations must be repeated in their original folder. */
export function retryRecordedStackAddress(raw: readonly string[], invokedFrom: string): string | undefined {
  if (raw.every(word => ["--foreground", "--no-manager", "--plain", "--json"].includes(word)))
    return `run ${codeSpan([displayCmd(), "up", ...raw].join(" "))} from ${shellWord(invokedFrom)}`;
  return undefined;
}

export async function retryStackAddress(raw: readonly string[], invokedFrom: string, stackServer: string, host: string): Promise<string | undefined> {
  const server = await stackRetryServer(stackServer, host);
  if (server !== undefined) return `start this stack at another address with ${codeSpan(upAtAddress(raw, server))} from ${shellWord(invokedFrom)}`;
}

export async function stackRetryServer(stackServer: string, host: string): Promise<string | undefined> {
  try { return await freshStackServer(await serverWithFreePort(stackServer, host), host); }
  catch { return undefined; }
}

function upAtAddress(raw: readonly string[], server: string): string {
  // Replay the validated command, replacing only --server (both accepted spellings).
  const words = [...raw];
  const end = words.includes("--") ? words.indexOf("--") : words.length;
  const at = words.slice(0, end).findLastIndex((word) => word === "--server" || word.startsWith("--server="));
  if (at !== -1) words.splice(at, words[at] === "--server" ? 2 : 1, "--server", server);
  else words.splice(end, 0, "--server", server);
  return `${displayCmd()} up ${words.map(shellWord).join(" ")}`;
}

export function legacyUpRetry(raw: readonly string[]) {
  return async (server: string, host: string): Promise<{ original: string; alternate?: string }> => {
    const original = upAtAddress(raw, server);
    let alternate: string;
    try { alternate = await freshStackServer(await serverWithFreePort(server, host), host); }
    catch { return { original }; }
    return { original, alternate: upAtAddress(raw, alternate.replace(/\/$/, "")) };
  };
}
