// Minimal ambient declarations so agentgw typechecks with zero installed deps.
// It runs under Bun (which provides these at runtime); these keep tsc quiet.

declare const process: { env: Record<string, string | undefined> };

declare namespace Bun {
  function serve(options: {
    port?: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): { port: number; stop(): void };
  const env: Record<string, string | undefined>;
}

declare const Buffer: {
  from(input: string | ArrayBuffer | Uint8Array, enc?: string): any;
  concat(list: any[]): any;
};

declare module "node:crypto" {
  export function createHash(alg: string): any;
  export function createCipheriv(alg: string, key: any, iv: any): any;
  export function randomBytes(n: number): any;
  export const randomUUID: () => string;
}
declare module "node:fs" {
  export function writeFileSync(path: string, data: string, opts?: { mode?: number }): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:os" {
  export function homedir(): string;
}
