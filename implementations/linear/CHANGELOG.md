# @cotal-ai/linear

## 0.90.1

## 0.90.0

## 0.89.0

## 0.88.0

## 0.87.0

### Patch Changes

- 45855d6: A Linear token or OAuth state file on Windows is no longer refused as "readable by other users (mode 666)". Windows reports every file's POSIX mode as 666, so the check refused every token-mode account there, including token files Cotal wrote itself. The mode check now applies only where POSIX modes exist, as for the broker TLS key and launch material; on Windows the file's privacy is the ACL Cotal sets when it writes the file.

## 0.86.0

## 0.85.0

## 0.84.0

## 0.83.0

## 0.82.2

## 0.82.1

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.0

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.1

## 0.77.0

## 0.76.0

## 0.75.0

### Patch Changes

- d269d1d: Core exports `serviceContractTable(rows)`, which builds a service's command contracts, compiled on first access, and the schema artifacts its registration publishes. The auth, manager and Linear service contracts call it instead of carrying their own copies of the lazy table and the artifact loop, so a fix to either reaches all three. Importing a contract module still compiles nothing, and the published artifacts and the behaviour of `AUTH_CONTRACTS`, `MANAGER_CONTRACTS` and `MANAGER_STATUS_CONTRACT` are unchanged.

## 0.74.0

### Minor Changes

- 328d59b: Add `@cotal-ai/linear`, which serves the official Linear MCP server as a registered Cotal endpoint that agents can call. `cotal linear serve <account> --endpoint <reverse-dns-name>` registers a fresh endpoint instance on a static-auth mesh through the ordinary registration path (contract store, issuance gate, registration barrier, serve grant, ready status, fenced serve credential), renews the serve credential, and removes the service record on shutdown. The endpoint name comes from operator configuration. `cotal linear caller` provisions an isolated hand-launched caller whose credential names only the five Linear commands. Per-user-auth meshes are refused rather than signed locally. Hosted embedders can use `runLinearEndpoint` with their own authorized serve bundle.

  The endpoint pins the two official Linear servers (`/mcp` and `/mcp/readonly`), takes an API key from stdin or a private file or runs Linear's OAuth login, and forwards tool, resource, prompt and completion requests without retrying. One deadline bounds queueing, discovery, connect and the call. A dispatched request that times out, is cancelled, overflows, loses its session or gets HTTP 401, 403 or 429 reports outcome `unknown`. `inventory` is paged under the broker message size, keeps every entry verbatim, and binds its cursors to the inventory digest, refusing a stale pin before anything reaches Linear.

  `@cotal-ai/core` adds `CotalEndpoint.describeService`, which returns the digest-verified surface from the same cache `invokeService` uses. `@cotal-ai/connector-core` adds the generic `cotal_describe` and `cotal_invoke` agent tools, which run on the agent's own connection and grants.
