/**
 * A LOCAL, OFFLINE OpenAI-compatible chat-completions server, for probes only.
 *
 * It exists so the real `opencode serve` can take a real model turn with NO external traffic: the
 * turn script is fixed here, not sampled. `plan` is a list of turn descriptors:
 *   { tool: "cotal_disconnect", args: {} }  → emit one tool call
 *   { text: "done" }                        → emit assistant text and stop
 *
 * Only a conversation carrying {@link MARKER} gets the script. That matters: the Cotal plugin owns
 * a session of its own and drives turns of its own, so a purely positional script would hand the
 * probe's tool calls to the plugin's conversation instead. Position within the scripted
 * conversation comes from how many cotal_* tool calls it already contains, so the plugin's
 * unrelated turns cannot shift it.
 */
import { createServer } from "node:http";

/** Only a conversation carrying this marker gets the scripted turns. */
export const MARKER = "COTAL-HOST-PROBE-MARKER";

export function startProvider(plan) {
  let turn = 0;
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "probe-model", object: "model" }] }));
        return;
      }
      if (!req.url.includes("chat/completions")) {
        res.writeHead(404).end("{}");
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
      seen.push(parsed);
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const step = !JSON.stringify(msgs).includes(MARKER)
        ? { text: "ok" }
        : plan[Math.min(msgs.filter((m) => JSON.stringify(m.tool_calls ?? "").includes("cotal_")).length, plan.length - 1)];
      turn++;
      const base = { id: `cmpl-${turn}`, object: "chat.completion.chunk", created: 0, model: "probe-model" };
      const call = { id: `call_${turn}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } };
      const chunks = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }];
      if (step.tool) {
        chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunks.push({ ...base, choices: [{ index: 0, delta: { content: step.text ?? "ok" }, finish_reason: null }] });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      chunks.push({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

      if (parsed?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // Non-streaming shape, for whichever path the SDK takes.
      const message = step.tool
        ? { role: "assistant", content: null, tool_calls: [call] }
        : { role: "assistant", content: step.text ?? "ok" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `cmpl-${turn}`, object: "chat.completion", created: 0, model: "probe-model",
        choices: [{ index: 0, message, finish_reason: step.tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, url: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close(), turns: () => turn });
    });
  });
}
