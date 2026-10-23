import { Circle, CircleDot, CircleHelp, CirclePause, CircleSlash } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const text = (value: unknown) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const statusIcons = { working: CircleDot, waiting: CirclePause, idle: Circle, offline: CircleSlash };
const statusColors: Record<string, string> = { working: "text-status-working", waiting: "text-status-waiting", idle: "text-status-idle", offline: "text-status-offline" };
export function Status({ status }: { status: string }) {
  const Icon = statusIcons[status as keyof typeof statusIcons] ?? CircleHelp;
  return <Icon role="img" aria-label={status} className={cn("size-4 shrink-0", statusColors[status])} />;
}
export function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
export function Harness({ connector, compact = false }: { connector: unknown; compact?: boolean }) {
  if (!connector) return null;
  const name = text(connector);
  const brand = Object.hasOwn(window.COTAL_HARNESS, name) ? window.COTAL_HARNESS[name] : undefined;
  const label = brand?.label || name;
  const mark = brand && <svg viewBox="0 0 24 24" fill={brand.outline ? "none" : "currentColor"} stroke={brand.outline ? "currentColor" : undefined} strokeWidth={brand.outline ? 2 : undefined} strokeLinecap="round" strokeLinejoin="round" data-icon="inline-start" aria-hidden="true" className={compact ? "size-4 shrink-0" : undefined}>{brand.paths.map((path,index) => <path key={index} d={path} />)}</svg>;
  if (compact && brand) return <Hint label={`Harness: ${label}`}><span role="img" aria-label={`Harness: ${label}`}>{mark}</span></Hint>;
  return <Hint label={`Harness: ${label}`}><Badge variant="outline">{mark}{label}</Badge></Hint>;
}
export function Blank({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}
export function MessageBody({ body, expandAll }: { body: string; expandAll: boolean }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [lastAll, setLastAll] = useState(expandAll);
  if (lastAll !== expandAll) { setLastAll(expandAll); setExpanded(null); }
  const open = expanded ?? expandAll;
  const long = body.length > 280;
  return <div className="min-w-0">
    <div className={cn("message-markdown", long && !open && "message-clamped")} dangerouslySetInnerHTML={{ __html: window.COTAL_DASHBOARD.markdown(body) }} />
    {long && <Button variant="link" size="sm" aria-expanded={open} onClick={() => setExpanded(!open)}>{open ? "Show less" : "Show more"}</Button>}
  </div>;
}
