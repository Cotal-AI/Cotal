import assert from "node:assert/strict";
import { registry, type Command } from "@cotal-ai/core";
import "../src/index.js";
import { CROSS_ORIGIN, WEB_HOST, makeAuthGate, normalizeWebHost, webUrl } from "../src/web.js";

let pass = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  assert.ok(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
  pass++;
  console.log(`  ok  ${name}`);
};
const req = (origin?: string) => ({ headers: origin === undefined ? {} : { origin }, url: "/" });
const query = (token: string) => new URLSearchParams(`k=${token}`);

const command = registry.resolve<Command>("command", "web");
const hostFlag = command.flags?.find((flag) => flag.name === "host");
check("the web command exposes explicit --host opt-in", hostFlag?.type === "string", hostFlag);

check("the default host remains IPv4 loopback", normalizeWebHost(undefined) === WEB_HOST && WEB_HOST === "127.0.0.1");
check("one selected remote IPv4 address is accepted", normalizeWebHost("192.0.2.10") === "192.0.2.10");
check("an IPv6 literal is normalized without brackets", normalizeWebHost("[2001:db8::10]") === "2001:db8::10");
check("an expanded IPv6 literal is normalized for one concrete URL", normalizeWebHost("2001:0db8::10") === "2001:db8::10");
assert.throws(() => normalizeWebHost("0.0.0.0"), /wildcard bind, not a browser address/,
  "IPv4 wildcard exposure must be refused rather than advertised");
pass++;
console.log("  ok  IPv4 wildcard exposure is refused");
assert.throws(() => normalizeWebHost("0"), /wildcard bind, not a browser address/,
  "an alternate IPv4 wildcard spelling must not bypass canonical validation");
pass++;
console.log("  ok  canonical IPv4 wildcard aliases are refused");
assert.throws(() => normalizeWebHost("::"), /wildcard bind, not a browser address/,
  "IPv6 wildcard exposure must be refused rather than advertised");
pass++;
console.log("  ok  IPv6 wildcard exposure is refused");
for (const host of ["::ffff:0.0.0.0", "::ffff:0:0", "0:0:0:0:0:ffff:0:0"]) {
  assert.throws(() => normalizeWebHost(host), /wildcard bind, not a browser address/,
    `IPv4-mapped wildcard exposure ${host} must be refused rather than advertised`);
  pass++;
}
console.log("  ok  IPv4-mapped wildcard aliases are refused");
assert.throws(() => normalizeWebHost("host/name"), /invalid --host/,
  "a host containing URL path syntax must be refused");
pass++;
console.log("  ok  URL path syntax cannot enter --host");

check("the untouched default keeps the branded loopback URL", webUrl(WEB_HOST, 7799) === "http://cotal.localhost:7799/");
check("a custom loopback port advertises plain loopback", webUrl(WEB_HOST, 8123) === "http://127.0.0.1:8123/");
check("a remote IPv4 selection is the advertised URL", webUrl("192.0.2.10", 8123) === "http://192.0.2.10:8123/");
check("a remote IPv6 selection is bracketed in the advertised URL", webUrl("2001:db8::10", 8123) === "http://[2001:db8::10]:8123/");

{
  const gate = makeAuthGate(8123, "192.0.2.10");
  const accepted = gate.check(req("http://192.0.2.10:8123") as never, query(gate.launchToken));
  check("the selected remote Origin can exchange the launch token", accepted !== undefined && "exchange" in accepted, accepted);
}

{
  const gate = makeAuthGate(8123, "192.0.2.10");
  const loopback = gate.check(req("http://127.0.0.1:8123") as never, query(gate.launchToken));
  check("remote exposure does not keep loopback as an extra allowed Origin",
    loopback !== undefined && "refuse" in loopback && loopback.refuse === CROSS_ORIGIN, loopback);
  const after = gate.check(req("http://192.0.2.10:8123") as never, query(gate.launchToken));
  check("a foreign Origin does not consume the launch token", after !== undefined && "exchange" in after, after);
}

console.log(`\nWEB REMOTE BIND SMOKE OK (${pass} checks)`);
