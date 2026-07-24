import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { AttachEndpoint } from "../dist/attach-endpoint.js";

let failures = 0;

function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

/** `token` undefined sends the upgrade with NO credential — the endpoint must refuse it before it
 *  ever looks at the (deliberately malformed) agent name. */
function malformedUpgrade(url: string, token?: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(port), hostname);
    let data = "";

    socket.setTimeout(2_000);
    socket.on("connect", () => {
      socket.write(
        `GET /attach/%${token ? `?t=${token}` : ""} HTTP/1.1\r\n` +
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

// A known token, so the smoke can present the credential the endpoint now requires on every route.
const TOKEN = "c".repeat(64);
const endpoint = new AttachEndpoint(
  () => undefined,
  () => [],
  () => [],
  0,
  "127.0.0.1",
  TOKEN,
);

await endpoint.start();
try {
  // consoleUrl() already carries the token — that is how a browser is handed the credential.
  const base = endpoint.consoleUrl();
  const res = await fetch(base);
  check("built manager console GET / returns 200", res.status === 200);
  check("built manager console serves HTML", (res.headers.get("content-type") ?? "").includes("text/html"));
  await res.text();

  // Credentialed but malformed: the name still fails to decode, so the request is a 400.
  const badUpgrade = await malformedUpgrade(base, TOKEN);
  check("malformed attach upgrade returns 400", badUpgrade.includes("400 Bad Request"));
  // Uncredentialed: refused BEFORE the name is parsed, so an anonymous caller learns nothing.
  const anonUpgrade = await malformedUpgrade(base);
  check("uncredentialed attach upgrade returns 401", anonUpgrade.includes("401 Unauthorized"));
  check(
    "endpoint survives malformed attach upgrade",
    (await fetch(new URL(`agents?t=${TOKEN}`, base))).status === 200,
  );
} finally {
  await endpoint.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
