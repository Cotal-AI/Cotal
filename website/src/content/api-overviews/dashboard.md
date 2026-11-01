The Dashboard HTTP API provides mesh observations, message history, and live events for the web dashboard.

## Connection

The default address is `http://127.0.0.1:7799`. The running dashboard can use a different host or port.
The [dashboard guide](/docs/watch-a-mesh/#web-dashboard) describes launch and access.

## Authentication

The owner-private launch URL exchanges its single-use `k` token for a `cotal_web_session` cookie.
The session stays on the same host. Requests from another browser origin are refused.
The readiness nonce grants access only to `/api/meta`.

## Available operations

The native web service is read-only. Channel deletion returns HTTP 403.
Legacy dashboard instances can support deletion. The `/api/meta` response reports this capability as `channelDeleteSupported`.

Operation pages in the sidebar describe parameters, response schemas, and live event payloads.
