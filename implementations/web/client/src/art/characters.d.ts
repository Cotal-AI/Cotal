export interface CotalArtApi {
  body(vendor: string, opts?: { look?: string; mood?: string }): string;
  mark(fill: string | string[]): string;
  CHARS: Record<string, { kind: string; fill: string; shade: string; name: string }>;
}
declare global { interface Window { CotalArt: CotalArtApi } }
export {};
