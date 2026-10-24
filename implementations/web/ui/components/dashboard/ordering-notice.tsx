import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { orderingNotices, type OrderNote } from "@/lib/ordering";

export function OrderingNotice({ notes }: { notes: readonly OrderNote[] }) {
  const notices = orderingNotices(notes);
  if (!notices.length) return null;
  return <div className="shrink-0 px-6 pb-2 pt-4"><Alert variant={notices.some(notice => notice.kind === "gap") ? "destructive" : "default"} className="p-4">
    <TriangleAlert /><AlertTitle>Stream ordering</AlertTitle>
    <AlertDescription><ul className="flex flex-col gap-1">{notices.map(notice => <li key={notice.kind}>{notice.message}</li>)}</ul></AlertDescription>
  </Alert></div>;
}
