import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof RadixDialog.Content>) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="overlay" />
      <RadixDialog.Content className={cn("dialog-content", className)} {...props}>
        {children}
        <RadixDialog.Close className="dialog-close" aria-label="Cerrar">
          <X size={16} />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return <div className="dialog-header">{children}</div>;
}

export const DialogTitle = ({ className, ...props }: ComponentProps<typeof RadixDialog.Title>) => (
  <RadixDialog.Title className={cn("dialog-title", className)} {...props} />
);

export const DialogDescription = ({ className, ...props }: ComponentProps<typeof RadixDialog.Description>) => (
  <RadixDialog.Description className={cn("dialog-description", className)} {...props} />
);

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="dialog-footer">{children}</div>;
}

export const DialogClose = RadixDialog.Close;
