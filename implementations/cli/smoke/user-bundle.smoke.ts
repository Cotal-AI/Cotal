/**
 * The user-bundle PRODUCER/CONSUMER contract, asserted across the package boundary.
 *
 * The auth daemon's public face serves a GENERATED bundle at /.well-known/cotal-mesh
 * (`composeUserBundle` + `finalizeUserBundleEndpoint`), and `cotal meshes add --from` consumes it
 * through `checkUserBundle`. Those two live in different packages, so nothing in either package's
 * own suite notices when they disagree — this smoke pins the round trip: what the daemon serves is
 * what registration accepts, field for field, including the pins registration goes on to record.
 */
import { checkAdvertisedServer, composeUserBundle, finalizeUserBundleEndpoint, spaceIssuer } from "@cotal-ai/auth";
import { checkServer, checkUserBundle, userExchangeIssuer } from "../src/commands/meshes-add.js";

let ran = 0;
let failed = 0;
function cell(name: string, ok: boolean, detail?: string): void {
  ran++;
  if (ok) {
    console.log(`ok - ${name}`);
    return;
  }
  failed++;
  console.error(`FAILED - ${name}${detail ? `\n    ${detail}` : ""}`);
}

const IDP = { url: "https://hosted.example/api/auth", issuer: "https://hosted.example", audience: "https://hosted.example" };
const SENTINEL = "-----BEGIN NATS USER JWT-----\nstub\n------END NATS USER JWT------\n";

// The lifecycle exactly as runAuthService drives it: compose, bind, finalize.
const bundle = composeUserBundle({
  space: "hosted",
  server: "wss://broker.example.com:443/mesh-ws",
  idp: IDP,
  sentinelCreds: SENTINEL,
});
finalizeUserBundleEndpoint(bundle, "https://hosted.example");

const parsed = checkUserBundle(JSON.stringify(bundle));
cell(
  "the generated bundle is accepted by checkUserBundle - the daemon serves what registration consumes",
  parsed.ok,
  parsed.ok ? undefined : `checkUserBundle said: ${(parsed as { message: string }).message}`,
);
if (parsed.ok) {
  const b = parsed.value;
  cell("the broker server rides through verbatim", b.server === "wss://broker.example.com:443/mesh-ws", `got ${JSON.stringify(b.server)}`);
  cell("tlsRequired is pinned true", b.tlsRequired === true);
  cell(
    // The name the LOCAL arm records (provider.ts registers publicAuth with provider "cotal"), so a
    // remote entry is the same provider as a local one and the provider dispatch cannot fork.
    'userAuth.provider is "cotal" - remote entries name the same provider local registrations do',
    b.userAuth.provider === "cotal",
    `got ${JSON.stringify(b.userAuth.provider)}`,
  );
  cell(
    "the finalized public URL is the pinned exchange endpoint (userAuth.endpoints.url)",
    b.userAuth.endpoints?.url === "https://hosted.example",
    `got ${JSON.stringify(b.userAuth.endpoints?.url)}`,
  );
  cell("the IdP pins ride through", b.userAuth.idp.url === IDP.url && b.userAuth.idp.issuer === IDP.issuer && b.userAuth.idp.audience === IDP.audience);
  cell("the sentinel blob rides the bundle", b.sentinelCreds === SENTINEL);
} else {
  // The acceptance cell above is the red arm; these would all pass trivially if skipped silently.
  for (let i = 0; i < 6; i++) cell("field cell skipped - the bundle was refused outright", false);
}

// --advertised-server takes the same scheme family `cotal meshes add` dials.
cell("advertised-server accepts wss", checkAdvertisedServer("wss://hosted.example/mesh-ws") === undefined);
cell("advertised-server accepts nats", checkAdvertisedServer("nats://10.0.0.7:4222") === undefined);
cell(
  "advertised-server refuses a non-broker scheme",
  (checkAdvertisedServer("https://hosted.example") ?? "").includes("must be a broker URL"),
);
cell("advertised-server refuses a non-URL", (checkAdvertisedServer("not a url") ?? "").includes("is not a URL"));

// Registration runs the bundle's server through checkServer AFTER checkUserBundle accepts it, so a
// bundle can pass the round trip above and still be refused at the gate that actually records it.
// A websocket broker legitimately lives under a path (`wss://host/mesh-ws` behind a reverse
// proxy) — the bundle's own server URL must clear checkServer, while nats:// stays bare.
cell("checkServer accepts the bundle's path-carrying wss server", checkServer(bundle.server).ok, JSON.stringify(checkServer(bundle.server)));
cell("checkServer still refuses a path on nats://", !checkServer("nats://10.0.0.7:4222/subject").ok);

// The issuer registration pins for the exchange probe is the daemon's OWN issuer (its /health
// reports `spaceIssuer(space)`), restated in the cli package because cli carries no runtime
// dependency on auth — this cell is the only thing keeping the two derivations identical.
cell(
  "the issuer registration pins equals the issuer the daemon's /health reports",
  userExchangeIssuer("hosted") === spaceIssuer("hosted"),
  `cli derives ${JSON.stringify(userExchangeIssuer("hosted"))}, auth derives ${JSON.stringify(spaceIssuer("hosted"))}`,
);

const EXPECTED_CELLS = 14;
if (ran !== EXPECTED_CELLS) {
  console.error(`ACCOUNTING BROKEN: ran ${ran} cells, expected ${EXPECTED_CELLS}`);
  process.exit(1);
}
if (failed > 0) {
  console.error(`${failed} FAILED / ${ran}`);
  process.exit(1);
}
console.log(`all ${ran} cells green`);
