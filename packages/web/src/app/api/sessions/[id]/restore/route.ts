import { type NextRequest, NextResponse } from "next/server";
import { getMockSession } from "@/lib/mock-data";

/** Terminal states that can be restored */
const RESTORABLE_STATUSES = new Set(["killed", "cleanup"]);
const RESTORABLE_ACTIVITIES = new Set(["exited"]);

/** POST /api/sessions/:id/restore — Restore a terminated session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getMockSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const isTerminal =
    RESTORABLE_STATUSES.has(session.status) || RESTORABLE_ACTIVITIES.has(session.activity);

  if (!isTerminal) {
    return NextResponse.json({ error: "Session is not in a terminal state" }, { status: 409 });
  }

  // TODO: wire to core SessionManager.restore()
  return NextResponse.json({ ok: true, sessionId: id });
}
