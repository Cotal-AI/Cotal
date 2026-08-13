import { strict as assert } from "node:assert";
import { endpointAuth, type Connection } from "../src/connect.js";

// TLS-required CLIENT INTENT must survive the trip from the mesh record to the wire.
//
// This is the failure with NO SYMPTOM. A connection that has lost its TLS requirement still works
// perfectly against an honest TLS broker, because a NATS client upgrades the same socket once it
// reads `tls_required` in the server's INFO. Nothing looks wrong. It only matters when an on-path
// attacker forges an INFO WITHOUT `tls_required`, at which point a client with no requirement of
// its own sends its credentials in the clear — and that is the whole reason this feature exists.
//
// So there is no live-broker assertion here that would catch a regression: against a real TLS
// broker, strict and non-strict clients behave identically. The only place the difference is
// visible is in the options actually handed to the client, which is what this pins. `tls-serve`
// covers the wire behaviour; this covers the plumbing that decides it.
//
// No brokers, no build — safe to run outside a build-lock hold.

const base = { server: "nats://127.0.0.1:4222", space: "s" };

// 1. A strict STATIC connection carries both identity and requirement.
{
  const conn: Connection = { ...base, tls: true, creds: "CREDS" };
  const opts = endpointAuth(conn);
  assert.equal(opts.creds, "CREDS", "static: creds must survive");
  assert.equal(opts.tls, true, "static: a TLS-REQUIRED connection must hand the client tls:true - without it the client is downgradeable by a forged INFO");
}

// 2. A strict USER-MODE connection does too. This path matters most: it carries a bearer, and a
//    bearer harvested in cleartext is a reusable credential.
{
  const conn: Connection = { ...base, tls: true, bearer: "BEARER", sentinelCreds: "SENTINEL" };
  const opts = endpointAuth(conn);
  assert.equal(opts.bearer, "BEARER", "user-mode: bearer must survive");
  assert.equal(opts.sentinelCreds, "SENTINEL", "user-mode: sentinel must survive");
  assert.equal(opts.tls, true, "user-mode: a TLS-REQUIRED connection must hand the client tls:true - a bearer sent in the clear is a reusable credential");
}

// 3. A non-strict connection must NOT claim TLS. The fence has to be honest in both directions:
//    inventing a requirement that was never recorded would be its own lie.
{
  const conn: Connection = { ...base, tls: false, creds: "CREDS" };
  const opts = endpointAuth(conn);
  assert.equal(opts.creds, "CREDS", "non-strict: creds must survive");
  assert.notEqual(opts.tls, true, "non-strict: must not claim a TLS requirement that was never recorded");
}

// 4. A credential-less strict connection still carries the requirement. An open mesh has no creds
//    to protect, but TLS on an open mesh is still meaningful — it buys CONFIDENTIALITY (traffic
//    hidden from a passive observer), even though it buys no AUTHENTICATION, because there are no
//    credentials to verify and anyone who can reach the port still gets in.
{
  const conn: Connection = { ...base, tls: true };
  assert.equal(endpointAuth(conn).tls, true, "open+strict: the requirement must survive even with no credentials attached");
}

console.log("tls-intent smoke: OK - TLS-required client intent survives endpointAuth on static, user-mode and credential-less connections, and is never invented when absent");
