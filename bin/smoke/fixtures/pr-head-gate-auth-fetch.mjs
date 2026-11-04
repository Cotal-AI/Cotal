import "./pr-head-gate-fetch.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";

const observed = { ghCalls: 0, requests: [] };
const exec = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, ...rest) {
  if (file === "gh" && args?.[0] === "auth" && args?.[1] === "token") observed.ghCalls++;
  return exec.call(this, file, args, ...rest);
};
syncBuiltinESMExports();
const fixtureFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization");
  observed.requests.push({
    authorized: authorization !== null,
    expectedToken: authorization === `Bearer ${process.env.PR_HEAD_GATE_EXPECT_TOKEN}`,
    raw: headers.get("accept") === "application/vnd.github.raw+json",
  });
  if (process.env.PR_HEAD_GATE_AUTH_404 === "1" && !authorization)
    return Promise.resolve(new Response("fixture private repository", { status: 404 }));
  return fixtureFetch(input, init);
};
process.on("exit", () => {
  writeFileSync(process.env.PR_HEAD_GATE_AUTH_RESULT, JSON.stringify(observed), { mode: 0o600 });
});
