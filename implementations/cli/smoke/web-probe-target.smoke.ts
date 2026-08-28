import assert from "node:assert/strict";
import { webProbeTarget } from "../src/commands/status.js";

const remote = webProbeTarget("node cotal web --host 192.0.2.10 --port 8123 --no-open");
assert.ok(!("refused" in remote) && remote.url.href === "http://192.0.2.10:8123/api/meta",
  "the CLI status probe uses the explicit dashboard host and port");

const ipv6 = webProbeTarget("node cotal web --host 2001:0db8::10 --port 8123");
assert.ok(!("refused" in ipv6) && ipv6.host === "2001:db8::10"
  && ipv6.url.href === "http://[2001:db8::10]:8123/api/meta",
  "the CLI status probe canonicalizes and brackets an IPv6 dashboard host");

const defaults = webProbeTarget("node cotal web --no-open");
assert.ok(!("refused" in defaults) && defaults.url.href === "http://127.0.0.1:7799/api/meta",
  "the CLI status probe preserves loopback defaults when host and port are absent");

for (const host of ["0.0.0.0", "0", "::", "::ffff:0.0.0.0", "::ffff:0:0", "0:0:0:0:0:ffff:0:0"]) {
  const wildcard = webProbeTarget(`node cotal web --host ${host}`);
  assert.ok("refused" in wildcard && wildcard.refused.includes("invalid process host"),
    `the CLI status probe refuses wildcard process host ${host}`);
}

console.log("web probe target smoke: explicit host, defaults, IPv6, and wildcard refusal passed");
