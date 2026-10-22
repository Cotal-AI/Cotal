import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawnNameError } from "@cotal-ai/core";
import { Modal } from "./Modal.js";
import type { AgentLaunchInput, AgentLaunchReply } from "../launch.js";

const FIELDS = ["application", "persona", "model", "name", "prompt", "events", "launch"] as const;
const LABELS = ["Application", "Persona", "Model", "Name", "Initial request", "Events"];

/** A deliberately small launch form. Empty values preserve native CLI defaults. Requests are
 * single-flight; an uncertain result cannot be submitted again from this form. */
export function NewAgent({ space, width, height, applications, defaultPersona, onLaunch, onBack, onClose }: {
  space: string; width: number; height: number; applications: string[]; defaultPersona: string;
  onLaunch: (input: AgentLaunchInput) => Promise<AgentLaunchReply>; onBack: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentLaunchInput>({ application: "", persona: defaultPersona, model: "", name: "", prompt: "", events: false });
  const [selected, setSelected] = useState(0);
  const draftRef = useRef(draft);
  const selectedRef = useRef(0);
  const terminal = useRef(false);
  const select = (index: number) => { selectedRef.current = index; setSelected(index); };
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AgentLaunchReply>();
  const [validation, setValidation] = useState<string>();
  const inFlight = useRef(false);
  const locked = reply !== undefined && (reply.ok || !reply.canRetry);
  const editable = !busy && !locked;
  const choices = ["", ...applications];
  const update = (key: keyof AgentLaunchInput, value: string | boolean) => {
    draftRef.current = { ...draftRef.current, [key]: value };
    setDraft(draftRef.current); setValidation(undefined); setReply(undefined);
  };
  const submit = () => {
    if (inFlight.current || terminal.current) return;
    const value = draftRef.current;
    const problem = value.name ? spawnNameError(value.name, { userMode: false }) : undefined;
    if (problem) { setValidation(problem); select(3); return; }
    if (!value.persona.trim()) { setValidation("Enter a persona name."); select(1); return; }
    inFlight.current = true; setBusy(true); setReply(undefined); setValidation(undefined);
    void onLaunch(value).then((result) => {
      terminal.current = result.ok || !result.canRetry;
      setReply(result);
    }, () => {
      terminal.current = true;
      setReply({ ok: false, canRetry: false, message: "Launch outcome unconfirmed. Inspect cotal ps before another launch." });
    }).finally(() => { inFlight.current = false; setBusy(false); });
  };
  useInput((input, key) => {
    if (inFlight.current) return;
    if (key.escape) return terminal.current ? onClose() : onBack();
    if (key.return && terminal.current) return onClose();
    if (width < 56 || height < 23) return;
    if (terminal.current) return;
    if (key.tab || key.upArrow || key.downArrow) {
      const direction = key.upArrow || (key.tab && key.shift) ? -1 : 1;
      select((selectedRef.current + direction + FIELDS.length) % FIELDS.length); return;
    }
    const field = FIELDS[selectedRef.current]!;
    if (field === "launch") { if (key.return) submit(); return; }
    if (field === "events") { if (key.return || input === " " || key.leftArrow || key.rightArrow) update("events", !draftRef.current.events); return; }
    if (field === "application" && (key.leftArrow || key.rightArrow || key.return)) {
      const direction = key.leftArrow ? -1 : 1;
      update("application", choices[(choices.indexOf(draftRef.current.application) + direction + choices.length) % choices.length]!); return;
    }
    if (key.return) { select(selectedRef.current + 1); return; }
    if (key.backspace || key.delete) { update(field, draftRef.current[field].slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) {
      const clean = input.replace(/[\x00-\x1f\x7f]/g, " ");
      if (draftRef.current[field].length + clean.length <= (field === "prompt" ? 4000 : 256)) update(field, draftRef.current[field] + clean);
    }
  });
  const narrow = width < 56 || height < 23;
  if (locked && reply) return <Modal title={reply.ok ? "Agent joined" : "Check launch outcome"} subtitle={`Space: ${space}`} width={width}>
    <Text color={reply.ok ? "green" : "yellow"}>{reply.ok ? `${reply.name} is running in the background.` : reply.message}</Text>
    {reply.ok ? <>
      <Text>Requested model: {reply.model ?? "native default"}</Text>
      <Text dimColor>Attach from the roster with a, where supported.</Text>
      {reply.warnings.map((warning, index) => <Text key={index} color="yellow">{warning}</Text>)}
    </> : reply.remedy ? <Text>{reply.remedy}</Text> : null}
    <Box marginTop={1}><Text dimColor>Enter or Esc returns to the console</Text></Box>
  </Modal>;
  return <Modal title="Spawn agent" width={width}>
    {narrow ? <Text color="yellow">Resize to at least 56 columns and 23 rows.</Text> : <>
      <Box flexDirection="column">
        {LABELS.map((label, index) => {
          const field = FIELDS[index] as Exclude<typeof FIELDS[number], "launch">;
          const focused = index === selected && editable;
          const value = field === "events" ? (draft.events ? "On" : "Off · console default") : draft[field];
          const placeholder = field === "application" ? "Persona / saved default" : field === "model" ? "Persona / application default" : field === "name" ? "Automatic" : field === "prompt" ? "Optional first task" : "Persona name";
          return <Box key={field}>
            <Box width={18} flexShrink={0}><Text color={focused ? "cyan" : undefined}>{focused ? "› " : "  "}{label}</Text></Box>
            <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end" color={focused ? "cyan" : undefined} dimColor={!value}>
              {value || placeholder}{focused ? " ▏" : ""}
            </Text></Box>
          </Box>;
        })}
      </Box>
      <Box marginTop={1}><Text inverse={selected === 6 && editable} bold color="cyan">{busy ? " Waiting for agent to join… " : selected === 6 ? "› Launch agent " : " Launch agent "}</Text></Box>
      {validation ? <Text color="red">{validation}</Text> : null}
      {reply && !reply.ok ? <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">{reply.message}</Text>
        {reply.remedy ? <Text dimColor>{reply.remedy}</Text> : null}
      </Box> : null}
      <Box marginTop={1}><Text dimColor>{busy ? "Launch in progress. This request will not be submitted twice." : "Tab / ↑↓ move · ←→ application · Enter select"}</Text></Box>
    </>}
  </Modal>;
}
