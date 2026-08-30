import { Fragment } from "react";
import { Box, Text } from "ink";
import type { Presence } from "@cotal-ai/core";
import type { FeedEntry } from "../mesh.js";
import { agentColor, STATUS, ago, fmtTime, wrapText } from "./theme.js";

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
  const role = entry.from.role && entry.from.role !== entry.from.name ? "/" + entry.from.role : "";
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
          <Text color={agentColor(entry.from.name)}>{entry.from.name}</Text>
          <Text dimColor>{role + "  " + entry.from.id}</Text>
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

function AgentDetail({ agent, feed, width }: { agent: Presence; feed: FeedEntry[]; width: number }) {
  const { card, status, activity, ts } = agent;
  const s = STATUS[status];
  const mine = feed.filter(
    (e) => e.from.name === card.name || (e.toNames ?? []).includes(card.name),
  );
  const recent = mine.slice(-6).reverse();
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
        <Text dimColor>{"  (heartbeat " + ago(ts) + " ago)"}</Text>
      </Field>
      {activity ? (
        <Field label="activity">
          <Text>{activity}</Text>
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
            return (
              <Text key={i} wrap="truncate-end">
                <Text dimColor>{fmtTime(e.ts) + " " + head + peer + ": "}</Text>
                {e.text.slice(0, Math.max(8, width - 24))}
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
}: {
  target: DetailTarget;
  feed: FeedEntry[];
  width: number;
  height: number;
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
    >
      <Text bold color="cyan">
        {title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {target.kind === "message" ? (
          <MessageDetail entry={target.entry} width={width - 4} />
        ) : (
          <AgentDetail agent={target.agent} feed={feed} width={width - 4} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
