/** Development only. Keep browser requests on one origin and retain the backend's auth gate. */
export function dashboardDevProxy() {
  return {
    name: "cotal-dashboard-backend",
    apply: "serve",
    config() {
      const value = process.env.COTAL_WEB_BACKEND;
      if (!value) throw new Error("Start a Cotal web service, then set COTAL_WEB_BACKEND to its loopback HTTP origin before running pnpm dev. See implementations/web/README.md.");
      let target;
      try { target = new URL(value); } catch { throw new Error("COTAL_WEB_BACKEND must be a valid loopback HTTP origin."); }
      if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash)
        throw new Error("COTAL_WEB_BACKEND must be a loopback HTTP origin without credentials, path or query.");
      return { server: { strictPort: true, proxy: {
        // The one-use browser link is exchanged by the backend, including its HttpOnly cookie.
        "^/\\?(?:[^#]*&)?k=": { target: target.origin, changeOrigin: true },
        "^/(?:api(?:/|$)|feed(?:\\?|$)|graph(?:\\.js)?(?:\\?|$)|vendor/|(?:app|snapshot|harness|parts|presence|agui-frame|event-order|md)\\.js(?:\\?|$))": {
          target: target.origin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (outgoing, incoming) => {
              // Only rewrite the dev page's own Origin. Foreign origins still reach the real
              // backend gate unchanged and are refused; no permissive CORS is introduced.
              if (incoming.headers.origin === `http://${incoming.headers.host}`)
                outgoing.setHeader("origin", target.origin);
            });
          },
        },
      } } };
    },
  };
}
