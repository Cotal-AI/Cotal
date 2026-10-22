// Copied from the shadcn/ui registry, version 4.22.1 (radix base, Rhea style, Hugeicons icons) on
// 2026-10-22. MIT licence, copyright (c) 2023 shadcn. Edited: the registry re-exports `cn` from the
// `cn` package; here it is the classic helper over clsx and tailwind-merge, so a className passed in
// still wins over a part's default class.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
