import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

export const Command = CommandPrimitive;

export const CommandInput = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) => (
  <CommandPrimitive.Input className={cn("command-input", className)} {...props} />
);

export const CommandList = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) => (
  <CommandPrimitive.List className={cn("command-list", className)} {...props} />
);

export const CommandEmpty = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) => (
  <CommandPrimitive.Empty className={cn("command-empty", className)} {...props} />
);

export const CommandGroup = ({ className, heading, ...props }: ComponentProps<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group
    className={className}
    heading={heading && <span className="command-group-heading">{heading}</span>}
    {...props}
  />
);

export const CommandItem = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item className={cn("command-item", className)} {...props} />
);

/** El diálogo modal (⌘K) que hospeda el Command de arriba. */
export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="command-dialog" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Paleta de comandos</DialogTitle>
        <Command shouldFilter loop>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
