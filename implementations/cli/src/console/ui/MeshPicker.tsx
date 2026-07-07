import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { loadMeshes, pruneStaleMeshes, type MeshEntry } from "@cotal-ai/workspace";
import { agentColor } from "./theme.js";

/** The run-anywhere landing view when SEVERAL meshes are registered: every broker on this machine
 *  (space, server, mode, root) with a selection cursor. Enter connects and drops into that mesh —
 *  its space overview on an open broker, straight into its one space under auth; `r` re-enumerates
 *  (pruning dead entries). Self-sizing, mirrors SpacePicker. See docs/watch-a-mesh.md. */
export function MeshPicker({
  meshes: initial,
  onSelect,
}: {
  meshes: MeshEntry[];
  /** Connects to the mesh (mint + preflight) — rejects with the rendered one-line error. */
  onSelect: (m: MeshEntry) => Promise<void>;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [meshes, setMeshes] = useState<MeshEntry[]>(initial);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | undefined>(); // space being connected to
  const [error, setError] = useState<string | undefined>();

  const selClamped = Math.min(sel, Math.max(0, meshes.length - 1));

  useInput(
    (input, key) => {
      if (input === "q") return exit();
      if (input === "r") {
        setError(undefined);
        // Re-enumerate with the same stale-prune the command runs at startup, so a crashed
        // broker's entry disappears on refresh rather than failing every Enter.
        void pruneStaleMeshes().then(() => setMeshes(loadMeshes()));
        return;
      }
      if (key.upArrow || input === "k") return setSel((v) => Math.max(0, v - 1));
      if (key.downArrow || input === "j") return setSel((v) => Math.min(meshes.length - 1, v + 1));
      if (key.return && meshes.length) {
        const m = meshes[selClamped];
        setBusy(m.space);
        setError(undefined);
        onSelect(m).catch((e: Error) => {
          // A failed enter may have pruned the entry — reload so the list reflects it.
          setBusy(undefined);
          setError(e.message);
          setMeshes(loadMeshes());
        });
      }
    },
    { isActive: !busy },
  );

  const capacity = Math.max(1, size.rows - 4 - (error ? 1 : 0)); // border (2) + title (1) + footer (1)
  let start = 0;
  if (meshes.length > capacity)
    start = Math.min(Math.max(0, selClamped - Math.floor(capacity / 2)), meshes.length - capacity);
  const visible = meshes.slice(start, start + capacity);

  return (
    <Box
      flexDirection="column"
      width={size.cols}
      height={size.rows}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
    >
      <Text wrap="truncate-end">
        <Text bold color="cyan">meshes</Text>
        {meshes.length ? <Text dimColor>{"  · " + meshes.length}</Text> : null}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {meshes.length === 0 ? (
          <Text dimColor>no mesh running — run `cotal up` in a project</Text>
        ) : (
          visible.map((m, i) => (
            <Row key={m.space} m={m} selected={start + i === selClamped} busy={busy === m.space} />
          ))
        )}
      </Box>
      {error ? (
        <Text color="red" wrap="truncate-end">
          {error}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        ↑↓ select · Enter open · r refresh · q quit
      </Text>
    </Box>
  );
}

function Row({ m, selected, busy }: { m: MeshEntry; selected: boolean; busy: boolean }) {
  const stats = m.server + " · " + m.mode + " · " + m.root + (busy ? " · connecting…" : "");
  if (selected)
    return (
      <Text inverse bold color="cyan" wrap="truncate-end">
        {"▸ " + m.space + "   " + stats}
      </Text>
    );
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{"  "}</Text>
      <Text color={agentColor(m.space)}>{m.space}</Text>
      <Text dimColor>{"   " + stats}</Text>
    </Text>
  );
}
