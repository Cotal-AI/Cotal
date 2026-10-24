import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { displayWidth, oneLine, renderReport } from "@cotal-ai/workspace";
import { feedLine, isFeedView, matchesWatchFilter, watchReport, watchViews, type WatchFilter } from "./watch-data.js";
import type { MeshView } from "./view/mesh-view.js";

/** Wrap without dropping a character, including long identities and wide graphemes. */
function lines(text: string, width: number): string[] {
  const result: string[] = [];
  let line = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(oneLine(text))) {
    const size = displayWidth(segment);
    if (line && used + size > width) { result.push(line); line = ""; used = 0; }
    line += segment;
    used += size;
  }
  if (line) result.push(line);
  return result;
}

export function WatchView({ view, initialFilter, onLeave }: { view: MeshView; initialFilter: WatchFilter; onLeave: () => void }) {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({ width: Math.max(20, stdout.columns ?? 80), height: Math.max(8, stdout.rows ?? 24) }));
  const [snapshot, setSnapshot] = useState(() => view.snapshot());
  const [filter, setFilter] = useState(initialFilter);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const resize = () => setSize({ width: Math.max(20, stdout.columns ?? 80), height: Math.max(8, stdout.rows ?? 24) });
    stdout.on("resize", resize);
    view.on("change", setSnapshot);
    return () => { stdout.off("resize", resize); view.off("change", setSnapshot); };
  }, [stdout, view]);
  const filters: readonly WatchFilter[] = snapshot.status.dmVisible ? watchViews : watchViews.filter((item) => item !== "dms");
  useInput((input, key) => {
    if (input === "q" || key.escape || key.ctrl && input === "c") return onLeave();
    if (input === "f") { setFilter((current) => filters[(filters.indexOf(current) + 1) % filters.length]!); setOffset(0); }
    if (key.upArrow || key.pageUp) setOffset((current) => isFeedView(filter) ? current + (key.pageUp ? size.height - 5 : 1) : Math.max(0, current - (key.pageUp ? size.height - 5 : 1)));
    if (key.downArrow || key.pageDown) setOffset((current) => isFeedView(filter) ? Math.max(0, current - (key.pageDown ? size.height - 5 : 1)) : current + (key.pageDown ? size.height - 5 : 1));
    if (input === "g") setOffset(0);
  });
  const content = useMemo(() => isFeedView(filter)
    ? snapshot.feed.filter((entry) => matchesWatchFilter(entry, filter)).flatMap((entry) => lines(feedLine(entry), size.width))
    : renderReport(watchReport(snapshot, filter), "plain", size.width).split("\n"), [snapshot, filter, size.width]);
  const title = lines(`cotal watch · ${snapshot.status.space}`, size.width);
  const connected = snapshot.status.connected && !snapshot.status.error;
  const connection = lines(connected ? `live · authorized ${filter}` : "Observer reported an error · last observations", size.width);
  const note = size.height < 12 ? [] : lines("Recent observations only. A turn ending is not task completion.", size.width);
  const keys = lines(size.width < 60 ? "f view · ↑↓ scroll · q leave" : "f view · ↑↓ scroll · g reset scroll · q leave · agents keep running", size.width);
  const bodyHeight = Math.max(1, size.height - title.length - connection.length - note.length - keys.length - 2);
  const scroll = Math.min(offset, Math.max(0, content.length - bodyHeight));
  const shown = isFeedView(filter) ? content.slice(Math.max(0, content.length - scroll - bodyHeight), content.length - scroll) : content.slice(scroll, scroll + bodyHeight);
  return <Box flexDirection="column" width={size.width} height={size.height}>
    {title.map((line, index) => <Text key={`title-${index}`} bold>{line}</Text>)}
    {connection.map((line, index) => <Text key={`connection-${index}`} color={connected ? undefined : "yellow"}>{line}</Text>)}
    <Text dimColor>{"─".repeat(size.width)}</Text>
    <Box flexDirection="column" height={bodyHeight}>
      {!shown.length ? <Text dimColor>{connected ? "Waiting for activity in this authorized view." : "No current feed. Events may be missing."}</Text> : shown.map((line, index) => <Text key={index}>{line}</Text>)}
    </Box>
    {note.map((line, index) => <Text key={`note-${index}`} dimColor>{line}</Text>)}
    <Text dimColor>{"─".repeat(size.width)}</Text>
    {keys.map((line, index) => <Text key={`keys-${index}`} dimColor>{line}</Text>)}
  </Box>;
}
