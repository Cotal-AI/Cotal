---
"@cotal-ai/cli": patch
---

The daemon lease check in `cotal down` passes an explicit object literal to `standaloneConnectOpts`. The resolved `creds` and `tls` bindings are passed directly at the call site so the required-argument seam reader can verify the `tls` decision statically.
