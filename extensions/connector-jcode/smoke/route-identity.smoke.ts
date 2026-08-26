/**
 * A seat must be able to say which provider is actually carrying its model.
 *
 * Measured: a seat requested as `gemini-3.7-flash` through a config whose default provider was
 * `cliproxy` logged every line as `prv:OpenRouter` and died with a `cursor_plugin_error`. Three
 * provider identities for one route, and none of them appeared in the roster, the spawn
 * confirmation, or the manager's exit line - establishing the truth meant reading the seat's private
 * log by hand (#785).
 *
 * Separately, `--model cliproxy/gemini-3.7-flash` was forwarded verbatim to an endpoint that wants a
 * bare id and came back `model_not_found`, naming neither the connector nor the prefix.
 */
import assert from "node:assert/strict";
import { bareModelId, describeRoute, type RuntimeIdentity } from "../src/route-identity.js";

let pass = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const detail = `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`;
  failures.push(detail);
  console.log(`  ✗ ${detail}`);
};

console.log("\n1. the measured case: the route's provider, not the session default");
{
  // The live shape: session default says one thing, the route serving this model says another.
  const runtime: RuntimeIdentity = {
    provider: "cliproxy",
    model: "gemini-3.7-flash",
    providers: ["cliproxy", "OpenRouter"],
    routes: [
      { model: "other-model", provider: "cliproxy", api_method: "responses" },
      { model: "gemini-3.7-flash", provider: "OpenRouter", api_method: "chat_completions" },
    ],
  };
  const line = describeRoute(runtime, "gemini-3.7-flash");
  check("names the provider actually serving THIS model", line.includes("OpenRouter"), line);
  check("does not report the session default as the carrier", !line.includes("provider cliproxy"), line);
  check("names the api method, so the wire shape is on the record", line.includes("chat_completions"), line);
  check("names the model it is describing", line.includes("gemini-3.7-flash"), line);
}

console.log("\n2. an unknown route is REPORTED, never guessed or silently skipped");
{
  check(
    "no routes and no provider says so explicitly",
    describeRoute({ routes: [] }, "m").includes("unreported provider"),
    describeRoute({ routes: [] }, "m"),
  );
  check("undefined runtime does not throw", describeRoute(undefined, "m").includes("unreported provider"));
  check(
    "a session provider is used when no route matches",
    describeRoute({ provider: "cliproxy", routes: [{ model: "elsewhere", provider: "x" }] }, "m").includes(
      "provider cliproxy",
    ),
  );
}

console.log("\n3. a route that reports itself unavailable says so");
{
  const line = describeRoute(
    { routes: [{ model: "m", provider: "p", api_method: "chat", available: false }] },
    "m",
  );
  check("an unavailable route is flagged", line.includes("UNAVAILABLE"), line);
  const ok = describeRoute({ routes: [{ model: "m", provider: "p", available: true }] }, "m");
  check("an available route is not flagged", !ok.includes("UNAVAILABLE"), ok);
}

console.log("\n4. the prefixed specifier is caught at the boundary, not forwarded");
{
  const bad = bareModelId("cliproxy/gemini-3.7-flash");
  check("a provider-prefixed id is refused", bad.ok === false);
  check("it reports the accepted bare form", bad.ok === false && bad.bare === "gemini-3.7-flash", bad);
  check("it names the prefix that was stripped", bad.ok === false && bad.prefix === "cliproxy", bad);
  check("a bare id passes", bareModelId("gemini-3.7-flash").ok === true);
}

console.log("\n5. edge shapes are not mistaken for a prefix");
{
  check("a leading slash is not a prefix", bareModelId("/model").ok === true);
  check("a trailing slash is not a prefix", bareModelId("provider/").ok === true);
  check("an empty string is not a prefix", bareModelId("").ok === true);
  const nested = bareModelId("a/b/c");
  check("only the first segment is treated as the prefix", nested.ok === false && nested.bare === "b/c", nested);
}

console.log(`\nroute identity: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`route identity: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
