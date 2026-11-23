import * as RadixRadioGroup from "@radix-ui/react-radio-group";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Construido y listo, sin consumidor todavía en ninguna pantalla actual. */
export function RadioGroup({ className, ...props }: ComponentProps<typeof RadixRadioGroup.Root>) {
  return <RadixRadioGroup.Root className={cn("radio-group", className)} {...props} />;
}

export function RadioGroupItem({ className, ...props }: ComponentProps<typeof RadixRadioGroup.Item>) {
  return (
    <RadixRadioGroup.Item className={cn("radio-item", className)} {...props}>
      <RadixRadioGroup.Indicator className="radio-item-indicator" />
    </RadixRadioGroup.Item>
  );
}
