/**
 * Pi's cotal_send gives the shared refusal for a channel pattern or a name that is no channel.
 *
 * pi registers the shared tool specs, so it advertises the shared `channel` text. Its own wrapper
 * used to answer a pattern first with "is not a concrete channel", so a pi session never saw the
 * two ways to reach a family that the text promises. This suite drives the real `registerCotalTools`
 * `execute` and asserts the shared refusal comes back, with the mesh agent untouched.
 *
 * Run: pnpm smoke:pi-send-refusal
 */
import { configFromEnv } from "@cotal-ai/connector-core";
import type { MeshAgent } from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCotalTools } from "../src/tools.js";

// `configFromEnv` reads the ambient environment, and whatever runs this suite may be a managed agent
// session. Drop the whole COTAL_ prefix at module scope before the first read, then set the suite's
// own values. Graded by `pnpm smoke:suite-ambient-env-self`.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_SPACE = "pisendrefusal";
process.env.COTAL_NAME = "pi-1";
// No connection is opened: every call below is refused before the tool touches the mesh agent.
process.env.COTAL_SERVERS = "nats://127.0.0.1:4222";

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }> };
const tools: Tool[] = [];
const pi = { registerTool: (def: Tool) => { tools.push(def); } } as unknown as ExtensionAPI;
const touched: string[] = [];
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) {
    touched.push(String(prop));
    throw new Error(`the refusal touched the mesh agent (${String(prop)})`);
  },
});

registerCotalTools(pi, agent, configFromEnv());
const send = tools.find((t) => t.name === "cotal_send");
check("pi registers cotal_send", send !== undefined, tools.map((t) => t.name));

const run = async (channel: string): Promise<string> => {
  try {
    const r = await send!.execute("call-1", { text: "hi", channel });
    return r.content.map((c) => c.text).join("\n");
  } catch (e) {
    return `threw: ${(e as Error).message}`;
  }
};

for (const channel of ["team.>", "#team.>"]) {
  const text = await run(channel);
  check(
    `pi refuses ${channel} with the shared pattern refusal, naming both ways`,
    text.includes('"team.>" is a pattern') && text.includes("post once to one channel it matches") && text.includes("cotal_channels lists the existing ones"),
    text,
  );
}
for (const channel of ["team.>.x", "team.**"]) {
  const text = await run(channel);
  check(`pi refuses ${channel} as no channel name`, text.includes(`${JSON.stringify(channel)} is not a channel name.`), text);
}
{
  const text = await run("#team.**");
  check('pi drops a leading # before the shared check, so #team.** is refused as "team.**"', text.includes('"team.**" is not a channel name.'), text);
}
check("no refusal touched the mesh agent", touched.length === 0, touched);

console.log(`\n${failures === 0 ? "PI-SEND-REFUSAL SMOKE OK ✅" : "PI-SEND-REFUSAL SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
