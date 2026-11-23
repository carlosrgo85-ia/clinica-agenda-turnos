import * as RadixProgress from "@radix-ui/react-progress";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Progress({ className, value = 0, ...props }: ComponentProps<typeof RadixProgress.Root>) {
  return (
    <RadixProgress.Root className={cn("progress-root", className)} value={value} {...props}>
      <RadixProgress.Indicator
        className="progress-indicator"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </RadixProgress.Root>
  );
}
