import chalk from "chalk";
import type { Command } from "commander";
import type { OrchestratorConfig } from "@agent-orchestrator/core";
import { loadConfig } from "@agent-orchestrator/core";
import { tmux, git } from "../lib/shell.js";
import { getSessionDir, readMetadata } from "../lib/metadata.js";
import { banner, header, formatAge, statusColor } from "../lib/format.js";

interface SessionInfo {
  name: string;
  branch: string | null;
  status: string | null;
  summary: string | null;
  pr: string | null;
  issue: string | null;
  lastActivity: string;
  project: string | null;
}

async function getTmuxSessions(): Promise<string[]> {
  const output = await tmux("list-sessions", "-F", "#{session_name}");
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

async function getTmuxActivity(session: string): Promise<number | null> {
  const output = await tmux(
    "display-message",
    "-t",
    session,
    "-p",
    "#{session_activity}"
  );
  if (!output) return null;
  const ts = parseInt(output, 10);
  return isNaN(ts) ? null : ts * 1000;
}

async function gatherSessionInfo(
  sessionName: string,
  sessionDir: string,
  worktreeDir?: string
): Promise<SessionInfo> {
  const metaFile = `${sessionDir}/${sessionName}`;
  const meta = readMetadata(metaFile);

  let branch = meta?.branch ?? null;
  const status = meta?.status ?? null;
  const summary = meta?.summary ?? null;
  const pr = meta?.pr ?? null;
  const issue = meta?.issue ?? null;
  const project = meta?.project ?? null;

  // Get live branch from worktree if available
  const worktree = meta?.worktree;
  if (worktree) {
    const liveBranch = await git(["branch", "--show-current"], worktree);
    if (liveBranch) branch = liveBranch;
  }

  // Get last activity time
  const activityTs = await getTmuxActivity(sessionName);
  const lastActivity = activityTs ? formatAge(activityTs) : "-";

  return { name: sessionName, branch, status, summary, pr, issue, lastActivity, project };
}

function printSession(info: SessionInfo): void {
  const statusStr = info.status ? ` ${statusColor(info.status)}` : "";
  console.log(
    `  ${chalk.green(info.name)} ${chalk.dim(`(${info.lastActivity})`)}${statusStr}`
  );
  if (info.branch) {
    console.log(`     ${chalk.dim("Branch:")} ${info.branch}`);
  }
  if (info.issue) {
    console.log(`     ${chalk.dim("Issue:")}  ${info.issue}`);
  }
  if (info.pr) {
    console.log(`     ${chalk.dim("PR:")}     ${chalk.blue(info.pr)}`);
  }
  if (info.summary) {
    console.log(
      `     ${chalk.dim("Summary:")} ${info.summary.slice(0, 65)}`
    );
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      let config: OrchestratorConfig;
      try {
        config = loadConfig();
      } catch {
        console.log(chalk.yellow("No config found. Run `ao init` first."));
        console.log(chalk.dim("Falling back to session discovery...\n"));
        // Fall back to finding sessions without config
        await showFallbackStatus();
        return;
      }

      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      console.log(banner("AGENT ORCHESTRATOR STATUS"));
      console.log();

      let totalSessions = 0;

      for (const [projectId, projectConfig] of Object.entries(projects)) {
        const prefix = projectConfig.sessionPrefix || projectId;
        const sessionDir = getSessionDir(config.dataDir, projectId);
        const projectSessions = allTmux.filter((s) => s.startsWith(`${prefix}-`));

        console.log(header(projectConfig.name || projectId));

        if (projectSessions.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          console.log();
          continue;
        }

        totalSessions += projectSessions.length;

        const infos: SessionInfo[] = [];
        for (const session of projectSessions.sort()) {
          const info = await gatherSessionInfo(session, sessionDir);
          infos.push(info);
        }

        if (opts.json) {
          console.log(JSON.stringify(infos, null, 2));
        } else {
          for (const info of infos) {
            printSession(info);
            console.log();
          }
        }
      }

      console.log(
        chalk.dim(
          `\n  ${totalSessions} active session${totalSessions !== 1 ? "s" : ""} across ${Object.keys(projects).length} project${Object.keys(projects).length !== 1 ? "s" : ""}`
        )
      );
      console.log();
    });
}

async function showFallbackStatus(): Promise<void> {
  const allTmux = await getTmuxSessions();
  if (allTmux.length === 0) {
    console.log(chalk.dim("No tmux sessions found."));
    return;
  }

  console.log(banner("AGENT ORCHESTRATOR STATUS"));
  console.log();
  console.log(
    chalk.dim(`  ${allTmux.length} tmux session${allTmux.length !== 1 ? "s" : ""} found\n`)
  );

  for (const session of allTmux.sort()) {
    const activityTs = await getTmuxActivity(session);
    const lastActivity = activityTs ? formatAge(activityTs) : "-";
    console.log(`  ${chalk.green(session)} ${chalk.dim(`(${lastActivity})`)}`);
  }
  console.log();
}
