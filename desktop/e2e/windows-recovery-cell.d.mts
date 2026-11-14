export const recoveryCells: string[];
export const recoveryWaitMs: number;
export function nativeRequestRows(file: string): any[];
export function heldBeforePoll(rows: any[], baseline: any, disableAtUnixMs: number, clickAtUnixMs: number, before: any): { held: boolean; interference: any[]; pending: any[]; baseline: any; disableAtUnixMs: number; clickAtUnixMs: number };
export function stoppedPoll(rows: any[], afterUnixMs: number): any;
export function restartRecovery(rows: any[], startedAtUnixMs: number, restart: any, observed: any, bridges: any[], peers: any[], appPid: number | undefined): { stopped: any; healthy: any; bridgeResult: any; bridgePeer: any; fresh: boolean; noInputRequests: boolean; passed: boolean };
export function requestSummary(rows: any[], afterUnixMs: number): object[];
