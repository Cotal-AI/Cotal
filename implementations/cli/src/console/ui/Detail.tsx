import { Fragment } from "react";
import { Box, Text } from "ink";
import { peerLabel, presenceText, type Presence } from "@cotal-ai/core";
import { displayWidth } from "@cotal-ai/workspace";
import type { FeedEntry } from "../mesh.js";
import { activityAge, presenceFacts } from "../../ui.js";
import { agentColor, STATUS, ago, clipText, fmtTime, wrapText } from "./theme.js";

/** What the user drilled into — a feed row or a roster entry. */
export type DetailTarget =
  | { kind: "message"; entry: FeedEntry }
  | { kind: "agent"; agent: Presence };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text>
      <Text dimColor>{(label + ":").padEnd(11)}</Text>
      {children}
    </Text>
  );
}

function deliveryTarget(e: FeedEntry) {
  if (e.delivery === "multicast") return <Text color="cyan">#{e.channel ?? "?"}</Text>;
  if (e.delivery === "anycast") return <Text color="magenta">@{e.toService ?? "?"}</Text>;
  const names = e.toNames ?? [];
  return (
    <Text>
      {names.map((n, i) => (
        <Fragment key={i}>
          {i > 0 ? <Text dimColor>, </Text> : null}
          <Text color={agentColor(n)}>{n}</Text>
        </Fragment>
      ))}
      {e.count && e.count > 1 ? <Text dimColor>{" (" + e.count + "×)"}</Text> : null}
    </Text>
  );
}

function MessageDetail({ entry, width }: { entry: FeedEntry; width: number }) {
  return (
    <Box flexDirection="column">
      <Field label="delivery">
        <Text>{entry.delivery}</Text>
      </Field>
      <Field label="time">
        <Text>{fmtTime(entry.ts)}</Text>
      </Field>
      <Field label="from">
        <Text>
          <Text color={agentColor(entry.from.name)}>{peerLabel(entry.from)}</Text>
          <Text dimColor>{"  " + entry.from.id}</Text>
        </Text>
      </Field>
      <Field label="to">{deliveryTarget(entry)}</Field>
      <Field label="id">
        <Text dimColor>{entry.id}</Text>
      </Field>
      <Box marginTop={1} flexDirection="column">
        <Text bold>body</Text>
        {wrapText(entry.text, Math.max(8, width - 4)).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}

/** The manager's managed-state for one agent (from the console's low-rate `ps` merge). */
export interface ManagedInfo {
  agent?: string; // connector name the manager launched (e.g. "claude")
  mode?: string; // runtime kind (pty / tmux / cmux)
}

function AgentDetail({ agent, feed, width, managed }: { agent: Presence; feed: FeedEntry[]; width: number; managed?: ManagedInfo }) {
  const { card, status, activity, ts } = agent;
  const s = STATUS[status];
  const { condition, ages } = presenceFacts(agent);
  const mine = feed.filter(
    (e) => e.from.name === card.name || (e.toNames ?? []).includes(card.name),
  );
  const recent = mine.slice(-6).reverse();
  // What the agent IS: the card's self-published harness metadata first (works on any mesh), the
  // manager's launch record filling in for children whose card carries no meta. Omitted when
  // neither knows — never faked.
  const meta = card.meta as Record<string, unknown> | undefined;
  const connector = typeof meta?.connector === "string" ? meta.connector : managed?.agent;
  const runs = connector ? connector + (managed?.mode ? " · " + managed.mode : "") : undefined;
  const model = typeof meta?.model === "string" ? meta.model : undefined;
  return (
    <Box flexDirection="column">
      <Field label="name">
        <Text color={card.kind === "agent" ? agentColor(card.name) : undefined}>{card.name}</Text>
      </Field>
      {card.role ? (
        <Field label="role">
          <Text>{card.role}</Text>
        </Field>
      ) : null}
      <Field label="kind">
        <Text>{card.kind}</Text>
      </Field>
      <Field label="status">
        <Text color={s.color}>{s.dot + " " + s.word + (status === "working" ? " · progress unknown" : "")}</Text>
        {condition ? <Text>{condition}</Text> : null}
        <Text dimColor>{ages + "  (heartbeat " + ago(ts) + " ago)"}</Text>
      </Field>
      {activity ? (
        <Field label="activity">
          <Text>{presenceText(activity)}</Text>
          <Text dimColor>{activityAge(agent)}</Text>
        </Field>
      ) : null}
      {card.description ? (
        <Field label="about">
          <Text dimColor>{card.description}</Text>
        </Field>
      ) : null}
      {card.tags?.length ? (
        <Field label="tags">
          <Text dimColor>{card.tags.join(", ")}</Text>
        </Field>
      ) : null}
      {runs ? (
        <Field label="runs">
          <Text>{runs}</Text>
        </Field>
      ) : null}
      {model ? (
        <Field label="model">
          <Text dimColor>{model}</Text>
        </Field>
      ) : null}
      {card.skills?.length ? (
        <Box flexDirection="column">
          <Field label="skills">
            <Text dimColor>{String(card.skills.length)}</Text>
          </Field>
          {card.skills.map((sk, i) => (
            <Text key={i} wrap="truncate-end">
              <Text>{" ".repeat(11) + (sk.name || sk.id)}</Text>
              {sk.description ? <Text dimColor>{"  " + sk.description}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold>{"recent traffic (" + mine.length + ")"}</Text>
        {recent.length === 0 ? (
          <Text dimColor>(none seen yet)</Text>
        ) : (
          recent.map((e, i) => {
            const sent = e.from.name === card.name;
            const head = sent ? "→ " : "← ";
            const peer = sent
              ? e.delivery === "multicast"
                ? "#" + (e.channel ?? "?")
                : e.delivery === "anycast"
                  ? "@" + (e.toService ?? "?")
                  : (e.toNames ?? []).join(", ")
              : e.from.name;
            const prefix = fmtTime(e.ts) + " " + head + peer + ": ";
            // Cut by columns between whole characters, to at most `width - 24` columns and to what the
            // row's `width - 2` (the card's border and padding take 6) leaves after the prefix. A preview
            // that leaves any text out ends with an ellipsis inside that room, so the terminal's
            // truncation never splits or straddles a wide one.
            const room = Math.min(Math.max(8, width - 24), width - 2 - displayWidth(prefix));
            const text = clipText(e.text, room);
            return (
              <Text key={i} wrap="truncate-end">
                <Text dimColor>{prefix}</Text>
                {text === e.text ? text : clipText(text, room - 1) + "…"}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

/** Full-screen detail overlay for the selected feed row or roster entry. */
export function Detail({
  target,
  feed,
  width,
  height,
  managed,
}: {
  target: DetailTarget;
  feed: FeedEntry[];
  width: number;
  height: number;
  /** id → managed-state, for the agent view's `runs` field (absent on unmanaged meshes). */
  managed?: Map<string, ManagedInfo>;
}) {
  const title = target.kind === "message" ? "message detail" : "agent detail";
  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      overflowY="hidden"
    >
      {/* Keep the whole card at its natural height and clip its tail on short terminals. */}
      <Box flexDirection="column" flexShrink={0}>
        <Box flexShrink={0}>
          <Text bold color="cyan">
            {title}
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          {target.kind === "message" ? (
            <MessageDetail entry={target.entry} width={width - 4} />
          ) : (
            <AgentDetail agent={target.agent} feed={feed} width={width - 4} managed={managed?.get(target.agent.card.id)} />
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>press any key to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
