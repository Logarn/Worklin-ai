import { AgentWorkflowCanvas } from "@/components/agent/agent-workflow-canvas";
import { cleanWorkflowId, serializeWorkflowRun } from "@/app/api/agent/workflows/shared";
import { prisma } from "@/lib/prisma";

type AgentWorkflowsPageProps = {
  searchParams?: Promise<{
    workflowId?: string | string[];
  }>;
};

export default async function AgentWorkflowsPage({ searchParams }: AgentWorkflowsPageProps) {
  const params = await searchParams;
  const rawWorkflowId = Array.isArray(params?.workflowId) ? params?.workflowId[0] : params?.workflowId;
  const initialWorkflowId = cleanWorkflowId(rawWorkflowId);
  const workflow = initialWorkflowId
    ? await prisma.workflowRun.findUnique({
        where: { id: initialWorkflowId },
      })
    : null;

  return (
    <AgentWorkflowCanvas
      initialWorkflowId={initialWorkflowId}
      initialWorkflow={workflow ? serializeWorkflowRun(workflow) : null}
    />
  );
}
