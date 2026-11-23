import * as RadixSlider from "@radix-ui/react-slider";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Construido y listo, sin consumidor todavía en ninguna pantalla actual. */
export function Slider({ className, ...props }: ComponentProps<typeof RadixSlider.Root>) {
  const values = props.value ?? props.defaultValue ?? [0];
  return (
    <RadixSlider.Root className={cn("slider-root", className)} {...props}>
      <RadixSlider.Track className="slider-track">
        <RadixSlider.Range className="slider-range" />
      </RadixSlider.Track>
      {values.map((_, i) => (
        <RadixSlider.Thumb className="slider-thumb" key={i} />
      ))}
    </RadixSlider.Root>
  );
}
