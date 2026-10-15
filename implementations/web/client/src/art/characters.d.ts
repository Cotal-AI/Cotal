/** What `characters.js` hands to `window.CotalArt` when it runs. Read it through `art/index.ts`,
 *  which is the only module that knows where the file puts it. */
export interface CotalArtApi {
  body(vendor: string, opts?: { look?: string; mood?: string }): string;
  mark(fill: string | string[]): string;
  CHARS: Record<string, { kind: string; fill: string; shade: string; name: string }>;
}
