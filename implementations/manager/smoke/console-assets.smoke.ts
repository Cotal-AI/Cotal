import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { AttachEndpoint } from "../dist/attach-endpoint.js";

let failures = 0;

function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

function malformedUpgrade(url: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(port), hostname);
    let data = "";

    socket.setTimeout(2_000);
    socket.on("connect", () => {
      socket.write(
        "GET /attach/% HTTP/1.1\r\n" +
          `Host: ${hostname}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("close", () => resolve(data));
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("malformed upgrade timed out"));
    });
    socket.on("error", reject);
  });
}

const index = join(process.cwd(), "implementations/manager/dist/console/index.html");
check("manager build emits dist/console/index.html", existsSync(index));

const endpoint = new AttachEndpoint(
  () => undefined,
  () => [],
  () => [],
);

await endpoint.start();
try {
  const base = endpoint.consoleUrl();
  const res = await fetch(base);
  check("built manager console GET / returns 200", res.status === 200);
  check("built manager console serves HTML", (res.headers.get("content-type") ?? "").includes("text/html"));
  await res.text();

  const badUpgrade = await malformedUpgrade(base);
  check("malformed attach upgrade returns 400", badUpgrade.includes("400 Bad Request"));
  check("endpoint survives malformed attach upgrade", (await fetch(new URL("agents", base))).status === 200);
} finally {
  await endpoint.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
