import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton", className)} {...props} />;
}

/** Grilla de tarjetas placeholder mientras carga una lista tipo grilla. */
export function CardSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="card-skeleton-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div className="card" key={i}>
          <Skeleton style={{ height: 16, width: "60%" }} />
          <Skeleton style={{ height: 12, width: "90%" }} />
          <Skeleton style={{ height: 12, width: "80%" }} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder genérico de página: título + un par de bloques. */
export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <Skeleton style={{ height: 28, width: 200 }} />
      <Skeleton style={{ height: 160 }} />
      <Skeleton style={{ height: 200 }} />
    </div>
  );
}
