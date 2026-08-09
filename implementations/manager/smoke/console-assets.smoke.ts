import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { AttachEndpoint } from "../dist/attach-endpoint.js";

let failures = 0;

function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

/** P2 item 6 deleted the `ws://.../attach/` terminal transport, so the face is HTTP-only and answers
 *  EVERY upgrade with a clean 400 rather than leaving a stray socket hanging. `token` is still varied
 *  here to prove the refusal is decided on the request's own shape, not on the credential. */
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
  () => [],
  () => [],
  0,
  undefined, // no session establisher: this smoke only exercises the static shell + the token gate
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

  // There is no WebSocket transport on this face any more (the terminal rides the mesh session), so
  // an upgrade is refused with a clean 400 — credentialed or not, and whatever the path says.
  const badUpgrade = await malformedUpgrade(base, TOKEN);
  check("a websocket upgrade returns 400 (HTTP-only face)", badUpgrade.includes("400 Bad Request"));
  const anonUpgrade = await malformedUpgrade(base);
  check("...and the same 400 uncredentialed, so neither answer leaks the other's outcome", anonUpgrade.includes("400 Bad Request"));
  check(
    "endpoint survives malformed attach upgrade",
    (await fetch(new URL(`agents?t=${TOKEN}`, base))).status === 200,
  );
} finally {
  await endpoint.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
