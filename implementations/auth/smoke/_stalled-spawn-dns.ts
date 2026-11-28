import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createInterface } from "node:readline";

const fixtureHost = "plugin-routing-stall.example.com";
const questionName = Buffer.concat([...fixtureHost.split(".").flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]), Buffer.from([0])]);
const program = `
  import { setServers } from 'node:dns';
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { port, keys, args, provider } = JSON.parse(input);
  setServers(['127.0.0.1:' + port]);
  const { cotalAuthProvider } = await import(provider);
  let reads = 0;
  const store = { get: async key => { if (key in keys) reads++; return keys[key]; } };
  const started = performance.now();
  const { actorToken } = await cotalAuthProvider.grantAgent({ ...args, store });
  console.log(JSON.stringify({ actorToken, elapsed: Math.round(performance.now() - started), reads }));
`;

export async function runSpawnDnsFixture(
  run: (server: string) => { args: object; keys: Record<string, string> },
  brokerPort?: number,
): Promise<{ actorToken: string; elapsed: number; reads: number; requests: number; exitMs: number }> {
  const dns = createSocket("udp4");
  let requests = 0;
  dns.on("message", (packet, peer) => {
    const questionEnd = 12 + questionName.length + 4;
    if (packet.length < questionEnd || !packet.subarray(12, questionEnd - 4).equals(questionName)) return;
    requests++;
    if (brokerPort === undefined) return;
    const question = Buffer.from(packet.subarray(0, questionEnd));
    const isA = question.readUInt16BE(questionEnd - 4) === 1;
    question.writeUInt16BE(0x8180, 2);
    question.writeUInt16BE(Number(isA), 6);
    question.writeUInt32BE(0, 8);
    const loopback = Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1]);
    dns.send(isA ? Buffer.concat([question, loopback]) : question, peer.port, peer.address);
  });
  dns.bind(0, "127.0.0.1");
  await once(dns, "listening");
  try {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    let exitedAt = 0;
    child.once("exit", () => { exitedAt = performance.now(); });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    let output = "", outputAt = 0, stderr = "";
    lines.on("line", line => { output = line; outputAt = performance.now(); });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
      child.stdin.end(JSON.stringify({ ...run(`nats://${fixtureHost}:${brokerPort ?? 4222}`), port: dns.address().port,
        provider: new URL("../dist/index.js", import.meta.url).href }));
      const [code, signal] = await closed;
      assert.equal(code, 0, `built provider subprocess ${signal ?? code}: ${stderr}`);
      assert.ok(outputAt > 0, "built provider subprocess emitted the receipt");
      const receipt = JSON.parse(output) as { actorToken: string; elapsed: number; reads: number };
      return { ...receipt, requests, exitMs: Math.max(0, Math.round(exitedAt - outputAt)) };
    } finally {
      clearTimeout(deadline);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  } finally {
    await new Promise<void>(resolve => dns.close(() => resolve()));
  }
}
