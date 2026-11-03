/** Child publisher for the real process-runtime smoke. */
import { CotalEndpoint } from "../src/index.js";
const [servers, space, lifecycleUid] = process.argv.slice(2);
if (!servers || !space || !lifecycleUid) throw new Error("runtime smoke child requires its isolated broker, space and lifecycle");
const ep = new CotalEndpoint({ servers, space, lifecycleUid, consume: false, channels: [], card: { id: "runtime_child", name: "child", kind: "agent" } });
ep.on("error", () => {});
try {
  await ep.start();
  process.send?.("ready");
  await new Promise<void>(resolve => { process.once("message", () => resolve()); });
} finally {
  await ep.stop();
  process.disconnect?.();
}
