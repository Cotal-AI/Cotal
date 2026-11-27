// Types for the command mod's exports, which the connector's TypeScript imports.
export function refusal(commands: readonly { name: string; source?: string }[], name: string): string | undefined;
export function rejected(op: string, message: string): Record<string, unknown>;
export function register(on: unknown): void;
