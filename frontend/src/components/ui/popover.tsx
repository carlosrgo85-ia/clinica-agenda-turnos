import * as RadixPopover from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;

export function PopoverContent({ className, sideOffset = 8, ...props }: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content className={cn("popover-content", className)} sideOffset={sideOffset} {...props} />
    </RadixPopover.Portal>
  );
}
