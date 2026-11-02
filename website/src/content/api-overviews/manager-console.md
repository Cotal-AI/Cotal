The Manager console HTTP API lists managed agents, provides a live feed, and establishes console sessions.
It is a separate listener from the [Dashboard HTTP API](/api/dashboard/).

## Connection

The default bind is `127.0.0.1` on an allocated port. The running manager announces the console address.
The operator can configure a different bind host or port.

## Authentication

Every data operation requires the per-manager console token, including requests over loopback.
The token can appear in an `Authorization: Bearer <token>` header or the `t` query parameter.
The query parameter takes precedence when both are present. The console launch page carries its token in the URL fragment.

## Console sessions

Session establishment returns a native session grant and caller credentials for a broker WebSocket connection.
The console HTTP listener does not provide a WebSocket terminal endpoint.
Operation pages describe the roster, feed, and session responses.
