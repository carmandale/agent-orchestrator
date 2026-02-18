/**
 * `ao perf` — API performance analysis from request logs.
 *
 * Subcommands:
 *   ao perf              — overview of route performance
 *   ao perf routes       — per-route p50/p95/p99 stats
 *   ao perf slow         — slowest recent requests
 *   ao perf cache        — cache hit rates
 *   ao perf enrichment   — PR enrichment timing breakdown
 */

import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, getLogsDir, readLogsFromDir } from "@composio/ao-core";
import { padCol } from "../lib/format.js";

/** Parse a relative time string into a Date. */
function parseSinceArg(since: string): Date {
  const match = since.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) return d;
    throw new Error(`Invalid time format: "${since}". Use "5m", "1h", "30s", or ISO 8601.`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms =
    unit === "s" ? value * 1000 :
    unit === "m" ? value * 60_000 :
    unit === "h" ? value * 3_600_000 :
    value * 86_400_000;
  return new Date(Date.now() - ms);
}

function resolveLogDir(): string {
  const config = loadConfig();
  const projectId = Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured.");
  const project = config.projects[projectId];
  return getLogsDir(config.configPath, project.path);
}

interface ParsedRequest {
  ts: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  error?: string;
  timings?: Record<string, number>;
  cacheStats?: { hits: number; misses: number; hitRate: number; size: number };
}

function loadRequests(logDir: string, opts?: { since?: Date; route?: string }): ParsedRequest[] {
  const entries = readLogsFromDir(logDir, "api", {
    source: "api",
    since: opts?.since,
  });

  const requests: ParsedRequest[] = [];
  for (const entry of entries) {
    const data = entry.data ?? {};
    if (!data["method"] || !data["path"]) continue;

    const req: ParsedRequest = {
      ts: entry.ts,
      method: String(data["method"]),
      path: String(data["path"]),
      statusCode: Number(data["statusCode"]) || 0,
      durationMs: Number(data["durationMs"]) || 0,
      error: data["error"] ? String(data["error"]) : undefined,
      timings: data["timings"] as Record<string, number> | undefined,
      cacheStats: data["cacheStats"] as ParsedRequest["cacheStats"] | undefined,
    };

    if (opts?.route && !req.path.includes(opts.route)) continue;
    requests.push(req);
  }

  return requests;
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

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function registerPerf(program: Command): void {
  const perfCmd = program
    .command("perf")
    .description("API performance analysis from request logs");

  perfCmd
    .command("routes")
    .description("Per-route p50/p95/p99 response time stats")
    .option("--since <time>", "Analyze requests since (e.g., 1h, 1d)")
    .option("--route <pattern>", "Filter by route pattern")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; route?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since, route: opts.route });

        if (requests.length === 0) {
          console.log(chalk.dim("No API request logs found."));
          return;
        }

        // Group by normalized route
        const byRoute = new Map<string, number[]>();
        const errorsByRoute = new Map<string, number>();
        for (const req of requests) {
          const key = `${req.method} ${normalizePath(req.path)}`;
          const durations = byRoute.get(key) ?? [];
          durations.push(req.durationMs);
          byRoute.set(key, durations);
          if (req.error || req.statusCode >= 400) {
            errorsByRoute.set(key, (errorsByRoute.get(key) ?? 0) + 1);
          }
        }

        if (opts.json) {
          const result: Record<string, unknown> = {};
          for (const [route, durations] of byRoute) {
            durations.sort((a, b) => a - b);
            result[route] = {
              count: durations.length,
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
              p99: percentile(durations, 99),
              errors: errorsByRoute.get(route) ?? 0,
            };
          }
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Table
        const COL = { route: 32, count: 7, p50: 8, p95: 8, p99: 8, errors: 7 };
        console.log(
          chalk.dim(
            "  " +
            padCol("Route", COL.route) +
            padCol("Count", COL.count) +
            padCol("p50", COL.p50) +
            padCol("p95", COL.p95) +
            padCol("p99", COL.p99) +
            "Errors",
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(70)));

        const sorted = [...byRoute.entries()].sort((a, b) => {
          const medA = percentile(a[1].sort((x, y) => x - y), 95);
          const medB = percentile(b[1].sort((x, y) => x - y), 95);
          return medB - medA;
        });

        for (const [route, durations] of sorted) {
          durations.sort((a, b) => a - b);
          const errors = errorsByRoute.get(route) ?? 0;
          console.log(
            "  " +
            padCol(chalk.cyan(route), COL.route) +
            padCol(String(durations.length), COL.count) +
            padCol(formatMs(percentile(durations, 50)), COL.p50) +
            padCol(formatMs(percentile(durations, 95)), COL.p95) +
            padCol(formatMs(percentile(durations, 99)), COL.p99) +
            (errors > 0 ? chalk.red(String(errors)) : chalk.dim("0")),
          );
        }
        console.log(chalk.dim(`\n  ${requests.length} total requests`));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("slow")
    .description("Show slowest recent requests")
    .option("--limit <n>", "Number of requests to show", "10")
    .option("--since <time>", "Analyze requests since")
    .option("--json", "Output as JSON")
    .action((opts: { limit?: string; since?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since });
        const limit = parseInt(opts.limit ?? "10", 10);

        const slowest = requests
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, limit);

        if (opts.json) {
          console.log(JSON.stringify(slowest, null, 2));
          return;
        }

        if (slowest.length === 0) {
          console.log(chalk.dim("No API request logs found."));
          return;
        }

        console.log(chalk.bold("\nSlowest Requests:\n"));
        for (const req of slowest) {
          const time = new Date(req.ts).toLocaleTimeString();
          const timingDetail = req.timings
            ? Object.entries(req.timings)
                .map(([k, v]) => `${k}: ${formatMs(v)}`)
                .join(", ")
            : "";
          console.log(
            `  ${chalk.yellow(formatMs(req.durationMs).padEnd(7))} ` +
            `${req.method} ${chalk.cyan(req.path)}  ` +
            chalk.dim(time),
          );
          if (timingDetail) {
            console.log(`           ${chalk.dim(`(${timingDetail})`)}`);
          }
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("cache")
    .description("Show cache hit rates")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const requests = loadRequests(logDir);

        // Find the most recent cache stats from request logs
        let latestStats: ParsedRequest["cacheStats"] | undefined;
        for (let i = requests.length - 1; i >= 0; i--) {
          if (requests[i].cacheStats) {
            latestStats = requests[i].cacheStats;
            break;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(latestStats ?? {}, null, 2));
          return;
        }

        if (!latestStats) {
          console.log(chalk.dim("No cache stats available yet. Hit the dashboard a few times first."));
          return;
        }

        const rate = (latestStats.hitRate * 100).toFixed(1);
        console.log(chalk.bold("\nCache Statistics:\n"));
        console.log(`  Hit rate:   ${chalk.green(rate + "%")} (${latestStats.hits} hits / ${latestStats.misses} misses)`);
        console.log(`  Cache size: ${latestStats.size} entries`);
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("enrichment")
    .description("PR enrichment timing breakdown")
    .option("--since <time>", "Analyze since")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since, route: "/api/sessions" });

        // Collect enrichment timings
        const enrichTimes: number[] = [];
        const listTimes: number[] = [];
        for (const req of requests) {
          if (req.timings?.["prEnrichment"]) enrichTimes.push(req.timings["prEnrichment"]);
          if (req.timings?.["sessionList"]) listTimes.push(req.timings["sessionList"]);
        }

        if (opts.json) {
          console.log(JSON.stringify({ enrichTimes, listTimes }, null, 2));
          return;
        }

        if (enrichTimes.length === 0) {
          console.log(chalk.dim("No enrichment timing data found. Hit the dashboard a few times first."));
          return;
        }

        enrichTimes.sort((a, b) => a - b);
        listTimes.sort((a, b) => a - b);

        console.log(chalk.bold("\nPR Enrichment Performance:\n"));
        console.log(`  Samples:    ${enrichTimes.length}`);
        console.log(`  p50:        ${formatMs(percentile(enrichTimes, 50))}`);
        console.log(`  p95:        ${formatMs(percentile(enrichTimes, 95))}`);
        console.log(`  p99:        ${formatMs(percentile(enrichTimes, 99))}`);

        if (listTimes.length > 0) {
          console.log(chalk.bold("\nSession List Performance:\n"));
          console.log(`  Samples:    ${listTimes.length}`);
          console.log(`  p50:        ${formatMs(percentile(listTimes, 50))}`);
          console.log(`  p95:        ${formatMs(percentile(listTimes, 95))}`);
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
