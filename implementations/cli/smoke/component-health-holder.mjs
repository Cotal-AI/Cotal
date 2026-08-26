import { CotalEndpoint } from "@cotal-ai/core";

const [server, space, instanceId] = process.argv.slice(2);
if (!server || !space || !instanceId) throw new Error("usage: component-health-holder <server> <space> <instanceId>");

const ep = new CotalEndpoint({
  space,
  servers: server,
  channels: [],
  consume: false,
  registerPresence: false,
  watchPresence: false,
  watchChannels: false,
  card: { name: "component-health-lease-holder", kind: "endpoint" },
});
ep.on("error", (error) => console.error(`endpoint error: ${error.message}`));
await ep.start();
let revision = await ep.acquireManagerLease({
  holder: ep.ref().id,
  instanceId,
  runtime: "pty",
  root: process.cwd(),
  pid: process.pid,
});
setInterval(() => {
  void ep.renewManagerLease({ holder: ep.ref().id, instanceId, runtime: "pty", root: process.cwd(), pid: process.pid }, revision)
    .then((next) => { revision = next; })
    .catch((error) => {
      console.error(`lease renewal failed: ${error.message}`);
      process.exitCode = 1;
    });
}, 500).unref();

console.log(JSON.stringify({ pid: process.pid, holder: ep.ref().id }));
await new Promise(() => {});
