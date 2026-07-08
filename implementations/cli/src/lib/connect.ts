// The connect-or-exit wrappers moved into `@cotal-ai/workspace` (stage 4) so every command
// surface — this CLI and cotal-web — resolves meshes identically. Re-exported here
// so existing importers (and `connect.smoke.ts`) keep resolving them from this module unchanged.
export {
  connectOrExit,
  endpointAuth,
  reachableOrExit,
  refuseStaticCredsForKnownUserAuthOrExit,
  resolveTargetOrExit,
  preflightOrExit,
  classifyPreflightFailure,
  userViewAuth,
  userViewAuthOrExit,
  type UserViewAuth,
  type ConnectFlags,
  type Connection,
  type RawAuth,
  type PreflightFailure,
} from "@cotal-ai/workspace";
