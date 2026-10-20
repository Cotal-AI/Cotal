import "../src/index.js";
import { join } from "../../cli/src/commands/join.js";
await join({ values: JSON.parse(process.env.JOIN_VALUES!), positionals: [], raw: [] });
