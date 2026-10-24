import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ChevronRight, CirclePause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Blank, Harness, Status, text } from "./primitives";
import type { Snapshot } from "@/lib/dashboard-types";

export function AgentDetails({ state }: { state: Snapshot }) {
  const p = state.agent;
  if (!p) return <Blank title="Agent no longer present" description="Choose another agent from the sidebar or attention panel." />;
  const wording = window.COTAL_PRESENCE.describe(p);
  const { card } = p;
  const meta = card.meta ?? {};
  const extra = Object.entries(meta).filter(([key]) => !["connector","model","variant"].includes(key)).sort(([a],[b])=>a.localeCompare(b));
  return <ScrollArea className="h-full"><div className="mx-auto flex max-w-3xl flex-col gap-5 p-5 sm:p-8">
    <div className="flex items-center gap-2 text-xs"><Status status={p.status} /><span>{wording.status}</span><span className="ml-auto text-muted-foreground">{wording.heartbeat}</span></div>
    <div className="flex flex-col gap-3"><div className="flex flex-wrap items-baseline gap-3"><h1 className="text-2xl font-semibold tracking-tight">{card.name}</h1><span className="text-sm text-muted-foreground">{card.role}</span></div><div className="flex flex-wrap gap-2"><Badge variant="secondary">{card.kind}</Badge><Harness connector={meta.connector} />{Boolean(meta.model || meta.connector) && <Badge variant="outline">{meta.model ? `${text(meta.model)}${meta.variant ? ` · ${text(meta.variant)}` : ""}` : "Model not reported"}</Badge>}{p.attention && p.attention !== "open" && <Badge variant="outline">{p.attention}</Badge>}</div>{card.description && <p className="text-sm leading-relaxed text-muted-foreground">{card.description}</p>}</div>
    <Card><CardHeader><CardTitle>{p.status === "waiting" ? "Blocked on" : "Current activity"}</CardTitle><CardDescription>{wording.activityAge || "Activity age not reported"}</CardDescription></CardHeader><CardContent className="whitespace-pre-wrap break-words text-sm">{p.activity || "No current activity reported"}</CardContent></Card>
    {Object.keys(p.channelModes ?? {}).length > 0 && <Card><CardHeader><CardTitle>Channel attention</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">{Object.entries(p.channelModes ?? {}).map(([channel, mode]) => <Badge variant="outline" key={channel}>#{channel} · {mode}</Badge>)}</CardContent></Card>}
    {!!card.tags?.length && <div className="flex flex-wrap gap-2">{card.tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}</div>}
    {!!card.skills?.length && <Card><CardHeader><CardTitle>Skills</CardTitle></CardHeader><CardContent><ItemGroup>{card.skills.map(skill => <Item key={skill.id} role="listitem"><ItemContent><ItemTitle className="line-clamp-none">{skill.name || skill.id}</ItemTitle>{skill.description && <ItemDescription className="line-clamp-none">{skill.description}</ItemDescription>}</ItemContent></Item>)}</ItemGroup></CardContent></Card>}
    {!!extra.length && <Card><CardHeader><CardTitle>Metadata</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Property</TableHead><TableHead>Value</TableHead></TableRow></TableHeader><TableBody>{extra.map(([key,value]) => <TableRow key={key}><TableHead scope="row">{key}</TableHead><TableCell className="whitespace-normal break-all">{text(value)}</TableCell></TableRow>)}</TableBody></Table></CardContent><CardFooter className="text-xs text-muted-foreground">Reported agent metadata</CardFooter></Card>}
    <Separator /><p className="break-all font-mono text-[10px] text-muted-foreground">{card.id}{card.protocolVersion && ` · protocol ${card.protocolVersion}`}</p>
  </div></ScrollArea>;
}
export function Attention({ state, onSelect, showHeader = true }: { state: Snapshot; onSelect?: () => void; showHeader?: boolean }) {
  return <section className="flex h-full min-h-0 flex-col" aria-label="Agents needing input">
    {showHeader && <div className="flex h-14 shrink-0 items-center gap-2 border-b px-6"><h2 className="text-sm font-medium">Needs you</h2><Badge variant="secondary">{state.waiting.length}</Badge></div>}
    <ScrollArea className="min-h-0 flex-1"><div className="p-4">{state.waiting.length > 0 ? <ItemGroup>{state.waiting.map(item => <Item key={item.id} role="listitem">
      <ItemMedia variant="icon"><CirclePause /></ItemMedia>
      <ItemContent className="min-w-0"><ItemTitle>{state.roster.find(peer => peer.card.id === item.id)?.card.name || item.title}</ItemTitle><ItemDescription className="line-clamp-none break-words">{item.status}</ItemDescription><ItemDescription className="line-clamp-none break-words">{item.desc}</ItemDescription><ItemDescription>{item.role} · {item.age}</ItemDescription></ItemContent>
      <ItemActions><Button variant="ghost" size="icon-sm" aria-label={`View ${state.roster.find(peer => peer.card.id === item.id)?.card.name || item.title}`} onClick={() => { window.COTAL_DASHBOARD.selectAgent(item.id); onSelect?.(); }}><ChevronRight /></Button></ItemActions>
    </Item>)}</ItemGroup> : <Blank title="All clear" description="Agents waiting for your input will appear here." />}</div></ScrollArea>
    <p className="shrink-0 px-6 py-4 text-xs leading-relaxed text-muted-foreground">Heartbeat age shows when an agent was last seen, not how long it has been waiting.</p>
  </section>;
}
