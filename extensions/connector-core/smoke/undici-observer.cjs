// Test-only preload (`node --require`): at process exit, write which Node-internal undici modules were loaded to
// the file named by COTAL_SMOKE_UNDICI_OUT. Uses fs only, so it cannot load undici itself. Never part of a shipped runtime.
const { writeFileSync } = require("node:fs");
const out = process.env.COTAL_SMOKE_UNDICI_OUT;
if (out) process.on("exit", () => writeFileSync(out, JSON.stringify({ undici: process.moduleLoadList.filter((name) => /undici/.test(name)) })));
