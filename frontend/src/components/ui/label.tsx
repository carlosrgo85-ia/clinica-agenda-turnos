import * as RadixLabel from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Label({ className, ...props }: ComponentProps<typeof RadixLabel.Root>) {
  return <RadixLabel.Root className={cn("label", className)} {...props} />;
}
