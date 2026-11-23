import { LoadingPanel, Skeleton } from "@/components/Loading";

export default function Loading() {
  return (
    <main className="page">
      <div className="stack">
        <LoadingPanel
          label="Opening this page"
          hint="Fetching the latest records from your workspace."
          estimateMs={1400}
          compact
        />
        <Skeleton height={44} width="42%" radius={10} />
        <div className="grid grid-auto">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={82} radius={13} />
          ))}
        </div>
        <div className="grid grid-2">
          <Skeleton height={240} radius={13} />
          <Skeleton height={240} radius={13} />
        </div>
      </div>
    </main>
  );
}
