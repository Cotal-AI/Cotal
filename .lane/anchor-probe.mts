import { findCotalRoot } from "../packages/workspace/src/index.js";
const [,, dir] = process.argv;
console.log(JSON.stringify({ from: dir, resolved: findCotalRoot(dir) }));
