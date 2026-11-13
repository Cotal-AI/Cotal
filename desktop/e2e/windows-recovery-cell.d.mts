export const recoveryCells: string[];
export const recoveryWaitMs: number;
export function nativeRequestRows(file: string): any[];
export function heldBeforePoll(rows: any[], baseline: any, disableAtUnixMs: number, clickAtUnixMs: number, before: any): { held: boolean; interference: any[]; pending: any[]; baseline: any; disableAtUnixMs: number; clickAtUnixMs: number };
export function stoppedPoll(rows: any[], afterUnixMs: number): any;
export function requestSummary(rows: any[], afterUnixMs: number): object[];
