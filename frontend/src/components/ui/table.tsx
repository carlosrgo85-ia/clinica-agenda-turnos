import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn("table", className)} {...props} />;
}
export const TableHeader = (props: HTMLAttributes<HTMLTableSectionElement>) => <thead {...props} />;
export const TableBody = (props: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />;
export const TableRow = (props: HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />;
export const TableHead = (props: ThHTMLAttributes<HTMLTableCellElement>) => <th {...props} />;
export const TableCell = (props: TdHTMLAttributes<HTMLTableCellElement>) => <td {...props} />;
