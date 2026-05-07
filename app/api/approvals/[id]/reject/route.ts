import { transitionApproval } from "@/app/api/approvals/shared";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  return transitionApproval(request, context, "rejected");
}
