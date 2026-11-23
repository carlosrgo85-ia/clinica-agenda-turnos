import * as RadixAvatar from "@radix-ui/react-avatar";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Avatar({ className, ...props }: ComponentProps<typeof RadixAvatar.Root>) {
  return <RadixAvatar.Root className={cn("avatar", className)} {...props} />;
}
export const AvatarImage = RadixAvatar.Image;
export const AvatarFallback = RadixAvatar.Fallback;

/** Iniciales a partir de un nombre ("Ana Pérez" -> "AP") o, si no hay, del email. */
export function initialsFrom(name?: string | null, email?: string | null): string {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}
