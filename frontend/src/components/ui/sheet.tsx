import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/**
 * Radix no tiene una primitiva de "Sheet" separada — es el mismo Dialog,
 * reposicionado como panel lateral en vez de modal centrado.
 */
export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;

interface SheetContentProps extends ComponentProps<typeof RadixDialog.Content> {
  side?: "left" | "right";
}

export function SheetContent({ className, side = "right", children, ...props }: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="overlay" />
      <RadixDialog.Content className={cn("sheet-content", `sheet-content--${side}`, className)} {...props}>
        {children}
        <RadixDialog.Close className="dialog-close" aria-label="Cerrar">
          <X size={16} />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export const SheetTitle = RadixDialog.Title;
export const SheetClose = RadixDialog.Close;
