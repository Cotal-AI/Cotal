// The victim of the stand-in check: a launched connector's control server, minted and served by the
// built connector-core exactly as a connector does. It answers hooks until `<epFile>.stop` appears,
// then closes cleanly: the connector process exiting while its harness session runs on.
// Argv: <repo root> <epFile>. Writes the endpoint and its launch material path to <epFile>.
import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [root, epFile] = process.argv.slice(2);
const core = await import(pathToFileURL(join(root, "extensions/connector-core/dist/index.js")).href);
// This script also runs against a build from before the control exchange, whose controlEndpoint took
// (space, name, token?) and whose material carried the key alone. The current one takes the launch's
// artifact list third, where its socket directory is recorded.
const artifacts = [];
const ep = core.controlEndpoint.length >= 3 ? core.controlEndpoint("standin-check", "victim", artifacts) : core.controlEndpoint("standin-check", "victim");
const env = core.materialEnv(ep.version ? { control: ep } : { controlToken: ep.token }, artifacts);
const server = core.startControlServer({}, ep, async (_agent, ev) => ({ systemMessage: `real server saw ${ev.hook_event_name}` }), { fatalBind: true });
server.on("listening", () => {
  writeFileSync(epFile, JSON.stringify({ path: ep.path, token: ep.token, material: env.COTAL_LAUNCH_MATERIAL, user: userInfo().username }));
  console.log(`victim: ${userInfo().username} serves ${ep.path}`);
});
const poll = setInterval(() => {
  if (!existsSync(`${epFile}.stop`)) return;
  clearInterval(poll);
  server.close(() => {
    console.log("victim: control server closed cleanly");
    process.exit(0);
  });
}, 50);
