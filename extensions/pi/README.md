# @cotal-ai/pi

Cotal as an extension for the operator's own [Pi coding agent](https://github.com/earendil-works/pi).
The package does not bundle Pi.

## Requirements

- Cotal and this package: Node 20 or newer.
- The Pi host: exactly `@earendil-works/pi-coding-agent@0.79.10` for this release.
- `pi` on `PATH` for managed spawning.

## Use

The published `cotal-ai` binary registers the connector:

```bash
npm install -g cotal-ai @earendil-works/pi-coding-agent@0.79.10
cotal up
cotal spawn default --detach --agent pi
```

To make ordinary interactive Pi sessions mesh-capable, copy the standalone artifact once:

```bash
mkdir -p ~/.pi/agent/extensions
cp node_modules/@cotal-ai/pi/dist/standalone.js ~/.pi/agent/extensions/cotal.js
```

The copied file has no repository-local or sibling-file imports. It activates only when a real
Cotal identity (`COTAL_NAME`, `COTAL_AGENT_FILE`, or `COTAL_LINK`) is present. Unrelated operator
settings such as `COTAL_HOME` and `COTAL_DEFAULT_AGENT` leave it inert. Pi SDK embedders using its
default resource loader discover the same file; embedders must bind extension lifecycle events as
required by Pi's SDK if they expect proactive delivery into an idle session.

## Delivery

Inbound traffic is injected as a `cotal-inbox` custom message. Its opaque batch details must appear
in Pi's `message_start` and in the exact provider `context`; only the following successful provider
response marks that batch consumed. Acknowledgement waits for a terminal agent boundary and drains
only an exact current inbox prefix.

- Crash or quit before a terminal boundary: acknowledge nothing; durable traffic redelivers.
- Provider-confirmed error or user abort: consume confirmed work so tools cannot repeat.
- Work not confirmed by the provider: retain it and enter an observable `waiting` hold.
- Overflow compaction with `willRetry`: retain the batch through Pi's automatic continuation.
- Watchdog or headless abort: never timer-replay while the original provider call may still run;
  managed restart is the safe recovery path.

The custom delivery path bypasses Pi's operator `input` transformation chain, because peer traffic
is attributed context rather than a human prompt. Provider hooks, tool hooks, and Pi's normal
permission/sandbox extensions still run. Replies remain deliberate model actions through
`cotal_dm`, `cotal_send`, or `cotal_anycast`; chat output alone is not sent to peers.

Pi resume, model variants, MCP sharing, and raw launch options are not implemented and fail loudly.
Persona files and `--model` are supported; an explicit spawn model wins over the persona file.

## Credits

The original Pi integration and inbox-turn design were contributed by
[Lanzelot1](https://github.com/Lanzelot1). Persona and model forwarding were contributed by
[TheReaperJay](https://github.com/TheReaperJay). Their authored commits remain in the integration
history; this package keeps the resulting Pi-specific code and behavior.
