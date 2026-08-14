// READ-ONLY diagnostic. Does NOT run `cotal setup` (measured to perform writes).
// It drives the exact functions the setup card calls, and prints the SOURCE each answer came from.
import { meshStatus } from "../implementations/cli/src/lib/status.js";
import { managerLiveness, managerUp, MANAGER_PID_PATH } from "../implementations/cli/src/lib/manager-proc.js";
import { isReachable, DEFAULT_SERVER } from "../packages/core/src/index.js";
import { existsSync } from "node:fs";

const cwd = process.argv[2] ?? process.cwd();
const REGISTERED = "nats://broker.cotal.ai:4222";

const card = await meshStatus(cwd);
console.log(JSON.stringify({
  probe: "what the setup card's mesh row actually asks",
  cwd,
  DEFAULT_SERVER,
  server_the_card_probed: card.server,
  card_says_reachable: card.reachable,
  card_space: card.space,
}, null, 2));

console.log(JSON.stringify({
  probe: "the REGISTERED mesh, which the card never asks about",
  registered_server: REGISTERED,
  registered_reachable: await isReachable(REGISTERED),
}, null, 2));

console.log(JSON.stringify({
  probe: "what the setup card's manager row actually asks",
  pidfile_path: MANAGER_PID_PATH(),
  pidfile_exists: existsSync(MANAGER_PID_PATH()),
  managerLiveness_five_valued: managerLiveness(),
  managerUp_boolean_the_card_uses: managerUp(),
}, null, 2));
