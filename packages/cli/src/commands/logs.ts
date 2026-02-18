/**
 * `ao logs` — query structured logs from the orchestrator.
 *
 * Subcommands:
 *   ao logs dashboard  — dashboard process stdout/stderr
 *   ao logs events     — lifecycle state transitions
 *   ao logs session <id> — events for a specific session
 */

import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  getLogsDir,
  readLogs,
  readLogsFromDir,
  tailLogs,
  type LogEntry,
  type LogQueryOptions,
} from "@composio/ao-core";

/** Parse a relative time string like "5m", "1h", "30s" into a Date. */
function parseSinceArg(since: string): Date {
  const match = since.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    // Try ISO 8601
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

/** Format a log entry for terminal display. */
function formatLogEntry(entry: LogEntry): string {
  const ts = new Date(entry.ts).toLocaleTimeString();
  const level = colorLevel(entry.level);
  const session = entry.sessionId ? chalk.cyan(entry.sessionId) + " " : "";
  return `${chalk.dim(ts)} ${level} ${session}${entry.message}`;
}

/** Color-code log level. */
function colorLevel(level: LogEntry["level"]): string {
  switch (level) {
    case "error": return chalk.red("ERR");
    case "warn": return chalk.yellow("WRN");
    case "stderr": return chalk.red("err");
    case "stdout": return chalk.dim("out");
    case "info": return chalk.blue("inf");
  }
}

/** Resolve log directory from config, first project. */
function resolveLogDir(): string {
  const config = loadConfig();
  const projectId = Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured.");
  const project = config.projects[projectId];
  return getLogsDir(config.configPath, project.path);
}

export function registerLogs(program: Command): void {
  const logsCmd = program
    .command("logs")
    .description("Query structured logs from the orchestrator");

  logsCmd
    .command("dashboard")
    .description("Show dashboard process logs")
    .option("--since <time>", "Show logs since (e.g., 5m, 1h, 2024-01-01)")
    .option("--level <level>", "Filter by level (stdout, stderr, info, warn, error)")
    .option("--tail <n>", "Show last N entries", "50")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; level?: string; tail?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const logPath = join(logDir, "dashboard.jsonl");

        if (opts.since) {
          const queryOpts: LogQueryOptions = {
            since: parseSinceArg(opts.since),
            level: opts.level ? [opts.level as LogEntry["level"]] : undefined,
          };
          const entries = readLogs(logPath, queryOpts);
          printEntries(entries, opts.json);
        } else {
          const n = parseInt(opts.tail ?? "50", 10);
          let entries = tailLogs(logPath, n);
          if (opts.level) {
            entries = entries.filter((e) => e.level === opts.level);
          }
          printEntries(entries, opts.json);
        }
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  logsCmd
    .command("events")
    .description("Show lifecycle event logs (state transitions)")
    .option("--since <time>", "Show events since (e.g., 5m, 1h)")
    .option("--session <id>", "Filter by session ID")
    .option("--type <type>", "Filter by event type pattern")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; session?: string; type?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();

        const queryOpts: LogQueryOptions = {
          source: "lifecycle",
          ...(opts.since && { since: parseSinceArg(opts.since) }),
          ...(opts.session && { sessionId: opts.session }),
          ...(opts.type && { pattern: opts.type }),
        };
        const entries = readLogsFromDir(logDir, "events", queryOpts);
        printEntries(entries, opts.json);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  logsCmd
    .command("session <id>")
    .description("Show all events for a specific session")
    .option("--json", "Output as JSON")
    .action((sessionId: string, opts: { json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const entries = readLogsFromDir(logDir, "events", { sessionId });
        if (entries.length === 0) {
          console.log(chalk.yellow(`No events found for session "${sessionId}"`));
          return;
        }
        printEntries(entries, opts.json);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printEntries(entries: LogEntry[], json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log(chalk.dim("No log entries found."));
  } else {
    for (const entry of entries) {
      console.log(formatLogEntry(entry));
    }
    console.log(chalk.dim(`\n${entries.length} entries`));
  }
}
