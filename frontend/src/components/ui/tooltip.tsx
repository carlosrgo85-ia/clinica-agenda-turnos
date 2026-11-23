import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof RadixTooltip.Content>) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content className={cn("tooltip-content", className)} sideOffset={sideOffset} {...props} />
    </RadixTooltip.Portal>
  );
}
