import * as RadixSeparator from "@radix-ui/react-separator";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: ComponentProps<typeof RadixSeparator.Root>) {
  return (
    <RadixSeparator.Root
      className={cn("separator", className)}
      orientation={orientation}
      decorative={decorative}
      {...props}
    />
  );
}
