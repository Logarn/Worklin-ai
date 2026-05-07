import { getApproval } from "@/app/api/approvals/shared";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  return getApproval(request, context);
}
