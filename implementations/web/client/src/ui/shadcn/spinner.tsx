// Edited: the props leave out the svg's strokeWidth, which HugeiconsIcon types as a number only,
// and its ref, which HugeiconsIcon types against its own copy of @types/react. As served, the
// registry file does not typecheck here.
import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth" | "ref">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
