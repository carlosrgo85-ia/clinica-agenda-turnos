import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const AlertDialog = RadixAlertDialog.Root;
export const AlertDialogTrigger = RadixAlertDialog.Trigger;

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof RadixAlertDialog.Content>) {
  return (
    <RadixAlertDialog.Portal>
      <RadixAlertDialog.Overlay className="overlay" />
      <RadixAlertDialog.Content className={cn("dialog-content", className)} {...props} />
    </RadixAlertDialog.Portal>
  );
}

export function AlertDialogHeader({ children }: { children: ReactNode }) {
  return <div className="dialog-header">{children}</div>;
}

export const AlertDialogTitle = ({ className, ...props }: ComponentProps<typeof RadixAlertDialog.Title>) => (
  <RadixAlertDialog.Title className={cn("dialog-title", className)} {...props} />
);

export const AlertDialogDescription = ({
  className,
  ...props
}: ComponentProps<typeof RadixAlertDialog.Description>) => (
  <RadixAlertDialog.Description className={cn("dialog-description", className)} {...props} />
);

export function AlertDialogFooter({ children }: { children: ReactNode }) {
  return <div className="dialog-footer">{children}</div>;
}

export const AlertDialogCancel = ({ className, ...props }: ComponentProps<typeof RadixAlertDialog.Cancel>) => (
  <RadixAlertDialog.Cancel className={cn("btn", "btn--outline", className)} {...props} />
);

export const AlertDialogAction = ({ className, ...props }: ComponentProps<typeof RadixAlertDialog.Action>) => (
  <RadixAlertDialog.Action className={cn("btn", "btn--destructive", className)} {...props} />
);
