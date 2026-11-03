/** What `characters.js` hands to `window.CotalArt` when it runs. Read it through `art/index.ts`,
 *  which is the only module that knows where the file puts it. */
export interface CotalArtApi {
  body(vendor: string, opts?: { look?: string; mood?: string }): string;
  mark(fill: string | string[]): string;
  /** A whole posed character (body, arms with hands, legs with shoes) as SVG markup, scaled to
   *  width `w` and centred on `cx`,`cy`. Points are in the body's 116-unit box. */
  character(o: {
    vendor: string;
    cx: number;
    cy: number;
    w: number;
    rot?: number;
    look?: string;
    mood?: string;
    arms?: { from: [number, number]; via: [number, number]; to: [number, number]; hand: string; deg: number | "auto"; size?: number }[];
    legs?: { from: [number, number]; to: [number, number]; dir: number; bend?: number }[];
  }): string;
  CHARS: Record<string, { kind: string; fill: string; shade: string; name: string }>;
}
