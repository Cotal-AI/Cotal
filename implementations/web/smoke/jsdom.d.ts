/** The part of jsdom the suites use. jsdom ships no types and `@types/jsdom` is not a dependency, so
 *  the one constructor `dom-globals.ts` and `markdown.smoke.ts` call is declared here. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean; runScripts?: "dangerously" | "outside-only" });
    readonly window: { document: unknown; close(): void } & Record<string, unknown>;
  }
}
