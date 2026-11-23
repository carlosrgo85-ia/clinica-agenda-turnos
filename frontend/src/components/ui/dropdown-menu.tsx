import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof RadixDropdownMenu.Content>) {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content className={cn("dropdown-content", className)} sideOffset={sideOffset} {...props} />
    </RadixDropdownMenu.Portal>
  );
}

interface DropdownMenuItemProps extends ComponentProps<typeof RadixDropdownMenu.Item> {
  destructive?: boolean;
}

export function DropdownMenuItem({ className, destructive, ...props }: DropdownMenuItemProps) {
  return (
    <RadixDropdownMenu.Item
      className={cn("dropdown-item", destructive && "dropdown-item--destructive", className)}
      {...props}
    />
  );
}

export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof RadixDropdownMenu.Separator>) => (
  <RadixDropdownMenu.Separator className={cn("dropdown-separator", className)} {...props} />
);

export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof RadixDropdownMenu.Label>) => (
  <RadixDropdownMenu.Label className={cn("dropdown-label", className)} {...props} />
);
