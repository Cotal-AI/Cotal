The public Auth HTTP API exchanges identity proofs and handles manager authority, service authority, and chat sessions.
Each operation has its own proof requirements.

## Connection

The public listener binds to `127.0.0.1`. An operator HTTPS proxy provides the configured public URL.
Query strings and trailing slashes do not match Auth routes.

## Authentication

Protected operations carry proofs in the JSON body. They do not require the host capability used by the [Auth host API](/api/auth-host/).
The token exchange accepts an identity-provider proof or a managed-agent secret, depending on the caller.

The listener sends no CORS headers. POST routes and the service authority GET route reject any `Origin` header.

## Request limits

JSON bodies default to 64 KiB. `POST /service-endpoint-authority` allows 2 MiB.
Public work has a limit of 64 concurrent admissions and a 10-second deadline.
Operation pages describe proof rules, refusal budgets, and response codes.
