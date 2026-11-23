import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Checkbox({ className, ...props }: ComponentProps<typeof RadixCheckbox.Root>) {
  return (
    <RadixCheckbox.Root className={cn("checkbox", className)} {...props}>
      <RadixCheckbox.Indicator>
        <Check size={14} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
