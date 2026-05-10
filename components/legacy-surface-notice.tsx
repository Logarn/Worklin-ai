import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

type LegacySurfaceNoticeProps = {
  title?: string;
  children: React.ReactNode;
};

export function LegacySurfaceNotice({
  title = "Legacy/internal surface",
  children,
}: LegacySurfaceNoticeProps) {
  return (
    <Card className="border-amber-300/25 bg-amber-400/10 shadow-none">
      <CardContent className="flex flex-col gap-3 pt-6 text-sm text-amber-50 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-semibold text-amber-100">{title}</p>
          <p className="mt-1 max-w-3xl text-amber-50/80">{children}</p>
        </div>
        <Link
          href="/agent"
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-amber-200/30 px-3 text-sm font-medium text-amber-50 hover:bg-amber-200/10"
        >
          Open Agent
        </Link>
      </CardContent>
    </Card>
  );
}
