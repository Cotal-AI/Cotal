export const publicDiagnosticLink = 'cotal://connect?idp=http%3A%2F%2F127.0.0.1%3A9%2Fapi%2Fauth&space=e2e-public-link';

/** Runs only in the attached application WebView. Never returns query, userinfo or fragment values. */
export const urlDiagnosticScript = `
const link = arguments[0];
let components;
try {
  const parsed = new URL(link);
  components = { protocol: parsed.protocol, hostname: parsed.hostname, pathname: parsed.pathname,
    port: parsed.port, hash: parsed.hash ? '[present]' : '' };
} catch {
  components = { error: 'URL_CONSTRUCTION_FAILED' };
}
const ua = navigator.userAgent;
const version = pattern => ua.match(pattern)?.[1] ?? null;
return { components, browser: { chromium: version(/Chrome\\/([0-9.]+)/),
  edge: version(/Edg\\/([0-9.]+)/), webkit: version(/AppleWebKit\\/([0-9.]+)/),
  safari: version(/Version\\/([0-9.]+)/) } };
`;

/** The caller supplies real app-WebView evaluation, never a Node URL substitute. */
export async function collectUrlDiagnostic(evaluate, link) {
  try {
    const value = await evaluate(urlDiagnosticScript, [link]);
    if (!value || Object.keys(value).sort().join(',') !== 'browser,components') throw new Error();
    const { components, browser } = value;
    const keys = Object.keys(components).sort().join(',');
    if (keys !== 'hash,hostname,pathname,port,protocol' && !(keys === 'error' && components.error === 'URL_CONSTRUCTION_FAILED')) throw new Error();
    if (keys !== 'error') {
      components.protocol = components.protocol === 'cotal:' ? components.protocol : '[unexpected]';
      components.hostname = ['', 'connect'].includes(components.hostname) ? components.hostname : '[unexpected]';
      components.pathname = ['', '/', 'connect', '/connect'].includes(components.pathname) ? components.pathname : '[unexpected]';
      components.port = typeof components.port === 'string' && /^[0-9]{0,5}$/.test(components.port) ? components.port : '[unexpected]';
      if (!['', '[present]'].includes(components.hash)) throw new Error();
    }
    if (Object.keys(browser).sort().join(',') !== 'chromium,edge,safari,webkit'
      || Object.values(browser).some(v => v !== null && (typeof v !== 'string' || !/^[0-9.]{1,64}$/.test(v)))) throw new Error();
    return { source: 'app-webview', components, browser };
  } catch { return { source: 'app-webview', error: 'WEBVIEW_EVALUATION_FAILED' }; }
}
