# @cotal-ai/connector-jcode

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

### Patch Changes

- 5fc753f: A jcode seat now records which provider is actually carrying its model, and refuses a
  provider-prefixed model id at the launch boundary. The connector already refused to join under a
  model label it did not receive, but that guarantee stopped at the model: a seat could be truthfully
  labelled while its traffic was carried by a component nobody named, and `RuntimeInfo` already
  carried the provider and routes in the same response the model check reads. A `provider/model`
  specifier was forwarded verbatim to an endpoint that expects a bare id, so the refusal came back as
  `model_not_found` naming neither the connector nor the prefix; it is now refused where the accepted
  form can be named.
- bd4fb99: A restarted jcode seat now resumes the session it left instead of silently starting blank. The host
  called `createSession` unconditionally, so `cotal stop` followed by `cotal spawn` forked a new
  session and orphaned the existing transcript: the seat came back looking healthy while remembering
  nothing, and the TUI, which is spawned with `--resume`, showed an attaching human the very history
  the agent could not recall. The host now looks for a prior session in the seat's own home and
  attaches it, choosing conservatively: the session must declare this seat's working directory, must
  not be archived, and must carry a non-empty transcript. When nothing is resumable it starts fresh
  and says so, and when it does resume it does not re-send the persona briefing into a transcript that
  already opens with it.

## 0.27.0

### Minor Changes

- 900f630: Add the Jcode Harness API connector with a private managed session, Cotal MCP bridge, and operator documentation.

### Patch Changes

- f982ef2: Use a short private API socket path and copied auth mirror when starting Jcode seats.
