import { Delete02Icon } from "@hugeicons/core-free-icons";
import { useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { Alert, AlertDescription } from "#client/ui/shadcn/alert.tsx";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "#client/ui/shadcn/alert-dialog.tsx";
import { Field, FieldLabel } from "#client/ui/shadcn/field.tsx";
import { Input } from "#client/ui/shadcn/input.tsx";
import type { Controller } from "../../state/controller.js";

/** The part of an element the dialog focuses. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Focusable = { focus(): void };

/** The type-the-name check before a channel is deleted (mock section B, before and after typing).
 *  `children` is the button that opens it.
 *
 *  - The destructive button names the channel and stays disabled until the field holds the name
 *    exactly, so a wrong tab cannot delete the wrong channel.
 *  - Confirming calls `controller.deleteChannel` and closes the dialog once it resolves. A refusal
 *    keeps the dialog open and shows the server's error in it, as it came.
 *  - The field takes focus when the dialog opens, Tab stays inside it, and Escape or Keep channel
 *    closes it. Closing puts focus back on the button that opened it. Each opening starts empty. */
export function DeleteChannelDialog({ channel, space, controller, children }: {
  channel: string;
  space: string | null;
  controller: Controller | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const matches = typed === channel;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setTyped("");
    setError(null);
    setBusy(false);
  };

  const confirm = async () => {
    if (!matches || controller === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.deleteChannel(channel);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (field.current as unknown as Focusable | null)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete #${channel}?`}</AlertDialogTitle>
          <AlertDialogDescription>{`This deletes every message in #${channel} for everyone${space ? ` on ${space}` : ""}. You can't undo it. If anyone posts to #${channel} again, it comes back empty.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={id}>
            <span>Type <b>{channel}</b> to confirm</span>
          </FieldLabel>
          <Input
            ref={field}
            id={id}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped((e.target as unknown as { value: string }).value)}
          />
        </Field>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep channel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!matches || busy || controller === null}
            onClick={(e) => {
              // The dialog closes only once the delete resolves, so a refusal can show in it.
              e.preventDefault();
              void confirm();
            }}
          >
            <Icon icon={Delete02Icon} data-icon="inline-start" />
            {`Delete #${channel}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
