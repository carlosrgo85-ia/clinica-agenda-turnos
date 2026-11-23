import * as RadixScrollArea from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof RadixScrollArea.Root>) {
  return (
    <RadixScrollArea.Root className={cn("scroll-area", className)} {...props}>
      <RadixScrollArea.Viewport style={{ height: "100%", width: "100%" }}>{children}</RadixScrollArea.Viewport>
      <RadixScrollArea.Scrollbar orientation="vertical" className="scroll-area-scrollbar">
        <RadixScrollArea.Thumb className="scroll-area-thumb" />
      </RadixScrollArea.Scrollbar>
    </RadixScrollArea.Root>
  );
}
