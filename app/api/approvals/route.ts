import { listApprovals } from "@/app/api/approvals/shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return listApprovals(request);
}
