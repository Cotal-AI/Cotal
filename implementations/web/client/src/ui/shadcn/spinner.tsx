// Copied from the shadcn/ui registry, version 4.22.1 (radix base, Rhea style, Hugeicons icons) on
// 2026-10-22. MIT licence, copyright (c) 2023 shadcn.
// Edited: imports are relative with their extensions and `cn` comes from ./lib/utils.ts, and the
// spin is slowed to 1.6s and stops under reduced motion, and it is decorative: it carries no
// role="status" and no "Loading" label, so a spinner inside a button or a live region adds no
// announcement of its own and the line around it speaks. The props leave out the svg's strokeWidth,
// which HugeiconsIcon types as a number only, and its ref, which HugeiconsIcon types against its own
// copy of @types/react.
import { cn } from "./lib/utils.ts"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth" | "ref">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" aria-hidden="true" className={cn("size-4 animate-spin [animation-duration:1.6s] motion-reduce:animate-none", className)} {...props} />
  )
}

export { Spinner }
