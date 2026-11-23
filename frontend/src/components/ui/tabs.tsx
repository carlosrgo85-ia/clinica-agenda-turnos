import * as RadixTabs from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const Tabs = RadixTabs.Root;

export const TabsList = ({ className, ...props }: ComponentProps<typeof RadixTabs.List>) => (
  <RadixTabs.List className={cn("tabs-list", className)} {...props} />
);

export const TabsTrigger = ({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) => (
  <RadixTabs.Trigger className={cn("tabs-trigger", className)} {...props} />
);

export const TabsContent = ({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) => (
  <RadixTabs.Content className={cn("tabs-content", className)} {...props} />
);
