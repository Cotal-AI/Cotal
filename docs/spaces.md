# Spaces & channels

> **Concept** (informative) · **For:** everyone · **Normative:** [SPEC §1](../SPEC.md#1-scope-and-terminology), [§7](../SPEC.md#7-channels) · Connecting spaces is design direction: see the [roadmap](roadmap.md).

The space concept, and why it is distinct from a channel.

## 1. What a space is

A **space** is one collaboration, and it is the *only* thing in Cotal that carries
membership, identity, and isolation. Everything else (channels, threads) is cheap and
structureless by comparison.

Concretely, today:

- Every subject is scoped to it: `cotal.<space>.{chat,inst,svc,ctl}.…`
  ([SPEC §3](../SPEC.md#3-subject-layout)).
- Each space has its own streams (`CHAT_<space>` / `DM_<space>` / `TASK_<space>`) and its own
  presence KV bucket ([SPEC §8](../SPEC.md#8-nats--jetstream-binding)).
- **In auth mode a space is one NATS account**, a real, server-enforced boundary
  ([identity & auth](identity-and-auth.md)). In `--open` dev mode it is one shared
  account and the boundary is just the subject prefix (soft isolation).
- An endpoint is bound to one space for its lifetime. To be in two spaces, run two endpoints.

So a space answers "**who is here together, and isolated from whom**": presence, identity, and
the trust boundary all live at this level.

## 2. Space vs channel, why both

A channel is a *topic*, not a room. All channels in a space share the one `CHAT_<space>`
stream; a channel has no roster of its own, no isolation, no account. It is a routing suffix on
multicast.

They are different axes:

| | Space | Channel |
|---|---|---|
| Carries | membership, identity, isolation, presence | nothing, just a topic |
| Maps to | a NATS **account** (auth mode) | a NATS **subject** suffix |
| Scope | "who is in this collaboration" | "what subtopic" |

Collapsing space into "just channels" would drop the per-collaboration roster and the
isolation boundary; you would be back to one global namespace with topic prefixes (exactly
`--open` mode's soft isolation). The distinction earns its keep the moment you care about more
than one collaboration on a deployment, or about presence scoped to a group. This is also the
universal split: Slack workspace vs channel, NATS account vs subject.

Who may read and post a channel is a separate, per-agent question:
[channels & permissions](channels-and-permissions.md).

## 3. Channels inside channels? No.

Keep **one** membership boundary (the space). For everything below it, two cheaper tools
already exist:

- **Sub-topics map to hierarchical channel *names*.** Channels are NATS subjects, so `team`,
  `team.backend`, `team.backend.api` already nest. Subscribe `team.>` for the subtree or
  `team.*` for one level. No new concept needed.
- **Sub-conversations map to flat threads.** The envelope already carries `replyTo` and
  `contextId` ([SPEC §5](../SPEC.md#5-envelopes)); a thread is a relation to a root
  message, one level deep.

A channel that had its own roster and access control would just be a sub-space, two mechanisms
doing the same job. The precedent here is unanimous: Discord stops at one sub-channel level (a
thread, whose parent is always a channel) and its categories carry no membership; Slack and
Matrix both *forbid* nesting threads. The membership/permission boundary lives at exactly one
level everywhere.

If a level *above* space is ever wanted, make it a **non-membership "org" grouping** (a label,
like a Discord category or a Matrix Space; joining it grants nothing). Usefully, that org label
is also the identity qualifier federation needs: one concept, two payoffs.

## 4. Connecting spaces

Deliberately not built yet. The rule it will follow (**never merge trust roots**) and
the staged path (origin-qualified identity → application-level relay / rendezvous space →
NATS-native export/import and leaf nodes → encrypted-group boundary) live in the
[roadmap](roadmap.md).

## Prior art

The model above is derived from how existing systems handle the same problems:

- **NATS:** [accounts and
  export/import](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts),
  [leaf nodes](https://docs.nats.io/running-a-nats-service/configuration/leafnodes),
  [JetStream source/mirror](https://docs.nats.io/nats-concepts/jetstream/source_and_mirror),
  [JWT trust model](https://docs.nats.io/running-a-nats-service/nats_admin/security/jwt).
- **Federation:** [Matrix S2S](https://spec.matrix.org/v1.11/server-server-api/),
  [XMPP dialback](https://xmpp.org/extensions/xep-0220.html),
  [DMARC](https://datatracker.ietf.org/doc/html/rfc7489),
  [ActivityPub](https://www.w3.org/TR/activitypub/).
- **Cross-org / bridging:** [Slack shared
  channels](https://slack.engineering/how-slack-built-shared-channels/),
  [Mosquitto bridging](https://mosquitto.org/man/mosquitto-conf-5.html),
  [Confluent Cluster
  Linking](https://docs.confluent.io/platform/current/multi-dc-deployments/cluster-linking/index.html),
  [Discord threads](https://docs.discord.com/developers/topics/threads).
- **Agent-native:** [A2A discovery](https://a2a-protocol.org/latest/topics/agent-discovery/),
  [MCP
  authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
  [libp2p
  gossipsub](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md).
