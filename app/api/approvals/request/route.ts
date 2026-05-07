import { requestApproval } from "@/app/api/approvals/shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return requestApproval(request);
}
