export { PROTOCOL_VERSION, unsupportedTransport } from "./protocol.js";
export { launchSeat, loadSeat, type LaunchSeatOpts, type SeatLaunchSpec } from "./launcher.js";
export { adoptSeat, adoptSeatSync, type SeatHandle, type SeatAttachSession } from "./handle.js";
export { processStartToken, readRecord, recordPath, seatId, socketPath, type SeatRecord } from "./record.js";
export { identityVerdict, reapSeat, type SeatReapEvidence } from "./reap.js";
export { SeatClient } from "./client.js";
export { runCustodian, type CustodianLaunch } from "./custodian.js";
export { StartupConfirmMatcher, normalizeConfirmText, unmatchedConfirmMessage } from "./startup-confirm.js";
