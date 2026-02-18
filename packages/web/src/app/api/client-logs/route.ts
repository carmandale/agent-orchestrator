import { NextResponse } from "next/server";
import { getLogsDir, LogWriter, loadConfig } from "@composio/ao-core";

interface ClientLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  url?: string;
  stack?: string;
  timing?: Record<string, number>;
}

let logWriter: LogWriter | null = null;

function getLogWriter(): LogWriter | null {
  if (logWriter) return logWriter;

  try {
    const config = loadConfig();
    const projectId = Object.keys(config.projects)[0];
    if (!projectId) return null;
    const project = config.projects[projectId];
    const logDir = getLogsDir(config.configPath, project.path);
    logWriter = new LogWriter({ filePath: `${logDir}/browser.jsonl` });
    return logWriter;
  } catch {
    return null;
  }
}

/** POST /api/client-logs — Ingest batched browser-side log entries. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { entries?: ClientLogEntry[] };
    if (!body.entries || !Array.isArray(body.entries)) {
      return NextResponse.json({ error: "Missing entries array" }, { status: 400 });
    }

    const writer = getLogWriter();
    if (!writer) {
      return NextResponse.json({ ok: true, logged: 0 });
    }

    for (const entry of body.entries) {
      const level = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info";
      writer.append({
        ts: new Date().toISOString(),
        level,
        source: "browser",
        sessionId: null,
        message: entry.message,
        data: {
          ...(entry.url && { url: entry.url }),
          ...(entry.stack && { stack: entry.stack }),
          ...(entry.timing && { timing: entry.timing }),
        },
      });
    }

    return NextResponse.json({ ok: true, logged: body.entries.length });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
