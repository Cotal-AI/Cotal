/**
 * P2 item 6 — the manager's mesh-attach session plane: the offer mint + redeem enforcement, the
 * PTY ↔ rail bridge, and the application framing over the core §13.6 session composite. The
 * generic composite (grant/redeem/rails/ledger) lives in `@cotal-ai/core` +
 * `implementations/auth`; this module is the manager-side CONSUMER that replaces the loopback
 * `ws://127.0.0.1` attach face.
 */
export {
  mintAttachOffer,
  staticRedemptionSeam,
  userModeRedemptionSeam,
  ManagerSessionRegistry,
  type AttachOffer,
  type MintAttachOfferArgs,
  type SessionTarget,
  type RedemptionSeam,
  type StaticRedemptionDeps,
} from "./establish.js";
export { serveSessionBridge, type ServeSessionBridgeOpts, type SessionBridge } from "./bridge.js";
export {
  ManagerSessionPlane,
  kvManagerSessionLedger,
  openSessionLedgerKv,
  type ManagerSessionPlaneDeps,
} from "./plane.js";
export {
  encodeAttachBytes,
  attachBytes,
  decodeAttachPayload,
  type AttachPayload,
  type AttachEndReason,
} from "./frame.js";
