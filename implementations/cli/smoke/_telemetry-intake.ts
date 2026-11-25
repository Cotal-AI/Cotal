import { createServer } from "node:http";
import { listenOn, onFreePort } from "@cotal-ai/smoke-kit";

export async function openTelemetryIntake() {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.headers["content-type"] === "application/json") received.push(JSON.parse(text));
      res.statusCode = 204;
      res.end();
    });
  });
  const port = await onFreePort((p) => listenOn(server, p));
  return { server, received, url: `http://127.0.0.1:${port}/v1/telemetry` };
}
