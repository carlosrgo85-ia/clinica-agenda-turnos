import * as RadixSwitch from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Construido y listo, sin consumidor todavía en ninguna pantalla actual. */
export function Switch({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root className={cn("switch", className)} {...props}>
      <RadixSwitch.Thumb className="switch-thumb" />
    </RadixSwitch.Root>
  );
}
