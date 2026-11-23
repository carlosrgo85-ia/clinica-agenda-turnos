import * as RadixCollapsible from "@radix-ui/react-collapsible";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const Collapsible = RadixCollapsible.Root;
export const CollapsibleTrigger = RadixCollapsible.Trigger;

export function CollapsibleContent({ className, ...props }: ComponentProps<typeof RadixCollapsible.Content>) {
  return <RadixCollapsible.Content className={cn("collapsible-content", className)} {...props} />;
}
