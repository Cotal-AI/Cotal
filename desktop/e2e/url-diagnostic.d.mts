export const publicDiagnosticLink: string;
export const urlDiagnosticScript: string;
export interface UrlDiagnostic {
  source: "app-webview";
  components?: { protocol: string; hostname: string; pathname: string; port: string; hash: "" | "[present]" } | { error: "URL_CONSTRUCTION_FAILED" };
  browser?: { chromium: string | null; edge: string | null; webkit: string | null; safari: string | null };
  error?: "WEBVIEW_EVALUATION_FAILED";
}
export function collectUrlDiagnostic(evaluate: (script: string, args: string[]) => Promise<unknown>, link: string): Promise<UrlDiagnostic>;
