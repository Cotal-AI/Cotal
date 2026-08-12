/**
 * A build-time `node:crypto` shim for the console session bundle (P2 item 6). The core §13.6 rail
 * (endpoint-session-rail) + terminal-frame codec (session-terminal-frames) transitively import
 * `node:crypto` at MODULE level — via endpoint-envelope → canonical.js (`createHash`) and
 * endpoint-subjects → subjects.js (`randomBytes`) — but they NEVER invoke hashing or uid-minting at
 * runtime (the rail moves bytes + derives subjects; the grant mint/verify that hashes stays on the
 * node side). esbuild aliases `node:crypto` to this so the module-level imports RESOLVE for the
 * browser.
 *
 * Both entries THROW LOUD if ever called: a reached call means the browser bundle started
 * hashing / uid-minting, which is a bug (the wrong code got pulled in), never a silent degrade — so
 * this is a fail-loud boundary, not a fallback.
 */
export function randomBytes(): never {
  throw new Error("node:crypto.randomBytes is not available in the console session bundle (the §13.6 rail/codec never mint uids in-browser; a reached call is a bug)");
}

export function createHash(): never {
  throw new Error("node:crypto.createHash is not available in the console session bundle (the §13.6 rail/codec never hash in-browser; a reached call is a bug)");
}
