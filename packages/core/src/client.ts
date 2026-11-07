/** Client endpoints using already-issued authority. Operator provisioning stays on the root. */
export {
  CotalEndpoint,
  DmDurableMissingError,
  DmBindRefusedError,
  PresenceWriteStuckError,
  isPermissionDenied,
  isPublishPermissionDenied,
  isAuthRejection,
  type EndpointOptions,
  type ChannelMember,
  type PresenceView,
  type DmOnlyOptions,
  type TransportState,
  type HistoryPage,
} from "./endpoint.js";
export type * from "./types.js";
export type { ResolvedService, SubmitAndFollowGoalOptions } from "./endpoint-invoke.js";
export type { EpAttributedReply, EpVerbTarget } from "./endpoint-verbs.js";
