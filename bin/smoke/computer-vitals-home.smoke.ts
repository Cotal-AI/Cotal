/** Run with HOME on its own local mount, in a private mount namespace. */
import assert from "node:assert/strict";
import { measureComputerVitals } from "@cotal-ai/manager";
const sample = await measureComputerVitals();
assert.ok(sample.cpu.logicalCount > 0);
assert.ok(sample.memory.totalBytes > 0);
assert.ok(sample.filesystems.some(fs => fs.mount === "~"));
assert.ok(sample.filesystems.every(fs => !fs.mount.includes(process.env.HOME!)));
console.log("personal mounted home retains CPU/memory and reports anonymous ~ volume", JSON.stringify(sample));
