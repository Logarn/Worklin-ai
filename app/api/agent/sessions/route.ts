import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEFAULT_STORE_ID } from "../../brain/profile/store";

export const maxDuration = 10;

const GREETING =
  "Want me to audit your retention setup? I can check products, campaigns, flows, audiences, performance readiness, and lifecycle coverage, then tell you what needs fixing.";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const latestOnly = url.searchParams.get("latest") === "1";
    if (latestOnly) {
      const session = await prisma.chatSession.findFirst({
        where: { storeId: DEFAULT_STORE_ID },
        orderBy: { updatedAt: "desc" },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      return NextResponse.json({ session });
    }

    const sessions = await prisma.chatSession.findMany({
      where: { storeId: DEFAULT_STORE_ID },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const session = await prisma.chatSession.create({
      data: {
        storeId: DEFAULT_STORE_ID,
        title: "New Chat",
        status: "active",
      },
    });

    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: GREETING,
      },
    });

    const full = await prisma.chatSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    return NextResponse.json({ session: full, sessionId: full.id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create session" },
      { status: 500 },
    );
  }
}
