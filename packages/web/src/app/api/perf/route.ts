import { NextResponse } from "next/server";
import { getLogsDir, readLogsFromDir, loadConfig } from "@composio/ao-core";

function resolveLogDir(): string {
  const config = loadConfig();
  const projectId = Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured.");
  const project = config.projects[projectId];
  return getLogsDir(config.configPath, project.path);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizePath(path: string): string {
  return path
    .replace(/\/sessions\/[^/]+/g, "/sessions/:id")
    .replace(/\/prs\/[^/]+/g, "/prs/:id");
}

/**
 * GET /api/perf — Performance statistics from API request logs.
 *
 * Query params:
 *   since — ISO 8601 timestamp
 *   route — filter by route pattern
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const since = searchParams.get("since");
    const route = searchParams.get("route");

    const logDir = resolveLogDir();
    const entries = readLogsFromDir(logDir, "api", {
      source: "api",
      ...(since && { since: new Date(since) }),
    });

    // Parse and group by route
    const byRoute = new Map<string, number[]>();
    const errorsByRoute = new Map<string, number>();
    const slowest: Array<{
      ts: string;
      method: string;
      path: string;
      durationMs: number;
      timings?: Record<string, number>;
    }> = [];

    let latestCacheStats: unknown = null;

    for (const entry of entries) {
      const data = entry.data ?? {};
      if (!data["method"] || !data["path"]) continue;

      const method = String(data["method"]);
      const path = String(data["path"]);
      const durationMs = Number(data["durationMs"]) || 0;

      if (route && !path.includes(route)) continue;

      const key = `${method} ${normalizePath(path)}`;
      const durations = byRoute.get(key) ?? [];
      durations.push(durationMs);
      byRoute.set(key, durations);

      if (data["error"] || (Number(data["statusCode"]) || 0) >= 400) {
        errorsByRoute.set(key, (errorsByRoute.get(key) ?? 0) + 1);
      }

      if (data["cacheStats"]) {
        latestCacheStats = data["cacheStats"];
      }

      slowest.push({
        ts: entry.ts,
        method,
        path,
        durationMs,
        timings: data["timings"] as Record<string, number> | undefined,
      });
    }

    // Build route stats
    const routes: Record<string, unknown> = {};
    for (const [routeKey, durations] of byRoute) {
      durations.sort((a, b) => a - b);
      routes[routeKey] = {
        count: durations.length,
        avgMs: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        p99Ms: percentile(durations, 99),
        errors: errorsByRoute.get(routeKey) ?? 0,
      };
    }

    // Top 10 slowest
    slowest.sort((a, b) => b.durationMs - a.durationMs);

    return NextResponse.json({
      routes,
      slowest: slowest.slice(0, 10),
      cacheStats: latestCacheStats,
      totalRequests: entries.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute perf stats" },
      { status: 500 },
    );
  }
}
