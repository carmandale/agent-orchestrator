/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Starts the dashboard and orchestrator agent session. The orchestrator prompt
 * is passed to the agent via --append-system-prompt (or equivalent flag) at
 * launch time — no file writing required.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import {
  loadConfig,
  findConfig,
  generateOrchestratorPrompt,
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import {
  findWebDir,
  buildDashboardEnv,
  findAvailableDashboardPort,
  writeRunState,
  readRunState,
  deleteRunState,
  type RunState,
} from "../lib/web-dir.js";
import {
  cleanNextCache,
  findRunningDashboardPid,
  waitForPortFree,
} from "../lib/dashboard-rebuild.js";

/**
 * Resolve project from config.
 * If projectArg is provided, use it. If only one project exists, use that.
 * Otherwise, error with helpful message.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects, no argument — error
  throw new Error(
    `Multiple projects configured. Specify which one to start:\n  ${projectIds.map((id) => `ao start ${id}`).join("\n  ")}`,
  );
}

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  const child = spawn("pnpm", ["run", "dev"], {
    cwd: webDir,
    stdio: "inherit",
    detached: true,
    env,
  });

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * Stop dashboard server.
 * Uses lsof to find the process listening on the port, then kills it.
 * Best effort — if it fails, just warn the user.
 */
async function stopDashboard(port: number): Promise<void> {
  try {
    // Find PIDs listening on the port (can be multiple: parent + children)
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);

    if (pids.length > 0) {
      // Kill all processes (pass PIDs as separate arguments)
      await exec("kill", pids);
      console.log(chalk.green("Dashboard stopped"));
    } else {
      console.log(chalk.yellow(`Dashboard not running on port ${port}`));
    }
  } catch {
    console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
  }
}

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description("Start orchestrator agent and dashboard for a project")
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .option("--prompt <text>", "Start with an inline prompt (rough idea mode)")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          prompt?: string;
        },
      ) => {
        try {
          const config = loadConfig();
          const { projectId, project } = resolveProject(config, projectArg);
          const sessionId = `${project.sessionPrefix}-orchestrator`;
          const port = config.port ?? 3000;

          // A5: Validate project path exists before spawning anything
          if (!existsSync(project.path)) {
            throw new Error(
              `Project path does not exist: ${project.path} — was it moved or deleted?`,
            );
          }

          // A2: Warn if defaultBranch was Zod-defaulted (no explicit key in raw YAML)
          const configPath = findConfig();
          if (configPath) {
            try {
              const rawYaml = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
              const rawProject = (rawYaml?.projects as Record<string, Record<string, unknown>> | undefined)?.[projectId];
              if (rawProject && !("defaultBranch" in rawProject)) {
                console.warn(
                  chalk.yellow(
                    `⚠ Project "${projectId}" has no explicit defaultBranch — defaulting to "main".\n` +
                    `  Run "ao project add" again or set defaultBranch in config to fix.\n`,
                  ),
                );
              }
            } catch {
              // Non-fatal — skip warning if raw YAML read fails
            }
          }

          console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

          // Start dashboard (unless --no-dashboard)
          const spinner = ora();
          let dashboardProcess: ChildProcess | null = null;
          let exists = false; // Track whether orchestrator session already exists
          let actualPort = port; // Track resolved port for summary

          if (opts?.dashboard !== false) {
            const webDir = findWebDir();
            if (!existsSync(resolve(webDir, "package.json"))) {
              throw new Error("Could not find @composio/ao-web package. Run: pnpm install");
            }

            if (opts?.rebuild) {
              const runningPid = await findRunningDashboardPid(port);
              if (runningPid) {
                console.log(chalk.dim(`Stopping dashboard (PID ${runningPid}) on port ${port}...`));
                try {
                  process.kill(parseInt(runningPid, 10), "SIGTERM");
                } catch {
                  // Process already exited (ESRCH) — that's fine
                }
                try {
                  await waitForPortFree(port, 5000);
                } catch {
                  // Graceful stop failed — force kill and retry once
                  try {
                    process.kill(parseInt(runningPid, 10), "SIGKILL");
                  } catch {
                    // Best effort
                  }
                  await waitForPortFree(port, 5000);
                }
              }
              await cleanNextCache(webDir);
            }

            // A3: Find available dashboard port (scan configured port through +10)
            actualPort = await findAvailableDashboardPort(port);
            if (actualPort !== port) {
              console.log(chalk.yellow(`Port ${port} in use — using ${actualPort} instead`));
            }

            spinner.start("Starting dashboard");
            dashboardProcess = await startDashboard(
              actualPort,
              webDir,
              config.configPath,
              config.terminalPort,
              config.directTerminalPort,
            );

            // A3+A4: Write run state for reliable cleanup by `ao stop`
            if (dashboardProcess.pid && config.configPath) {
              const env = await buildDashboardEnv(
                actualPort, config.configPath, config.terminalPort, config.directTerminalPort,
              );
              const terminalPorts = [
                parseInt(env["TERMINAL_PORT"], 10),
                parseInt(env["DIRECT_TERMINAL_PORT"], 10),
              ].filter((p) => !isNaN(p));
              writeRunState(config.configPath, projectId, {
                configPath: config.configPath,
                projectName: projectId,
                dashboardPid: dashboardProcess.pid,
                dashboardPort: actualPort,
                terminalPorts,
                startedAt: new Date().toISOString(),
                pgid: dashboardProcess.pid, // detached spawn: PID === PGID
              });
            }

            spinner.succeed(`Dashboard starting on http://localhost:${actualPort}`);
            console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
          }

          // Create orchestrator session (unless --no-orchestrator or already exists)
          let tmuxTarget = sessionId; // For the attach hint — updated to hash-based name after spawn
          if (opts?.orchestrator !== false) {
            const sm = await getSessionManager(config);

            // Check if orchestrator session already exists
            const existing = await sm.get(sessionId);
            exists = existing !== null && !TERMINAL_STATUSES.has(existing.status);

            if (exists && opts?.prompt) {
              throw new Error(
                `Orchestrator session "${sessionId}" is already running.\n` +
                  `To start with a new prompt, stop the existing session first:\n` +
                  `  ao stop ${projectArg ?? ""}\n` +
                  `  ao start ${projectArg ?? ""} --prompt "..."`,
              );
            }

            if (exists) {
              if (existing?.runtimeHandle?.id) {
                tmuxTarget = existing.runtimeHandle.id;
              }
              console.log(
                chalk.yellow(
                  `Orchestrator session "${sessionId}" is already running (skipping creation)`,
                ),
              );
            } else {
              try {
                spinner.start("Creating orchestrator session");
                const systemPrompt = generateOrchestratorPrompt({
                  config,
                  projectId,
                  project,
                  prompt: opts?.prompt,
                });

                const session = await sm.spawnOrchestrator({
                  projectId,
                  systemPrompt,
                  initialPrompt: opts?.prompt
                    ? "Start building. Follow your system prompt."
                    : undefined,
                });
                if (session.runtimeHandle?.id) {
                  tmuxTarget = session.runtimeHandle.id;
                }
                spinner.succeed("Orchestrator session created");
              } catch (err) {
                spinner.fail("Orchestrator setup failed");
                // Cleanup dashboard if orchestrator setup fails
                if (dashboardProcess) {
                  dashboardProcess.kill();
                }
                throw new Error(
                  `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
                  { cause: err },
                );
              }
            }
          }

          // Print summary based on what was actually started
          console.log(chalk.bold.green("\n✓ Startup complete\n"));

          if (opts?.dashboard !== false) {
            console.log(chalk.cyan("Dashboard:"), `http://localhost:${actualPort}`);
          }

          if (opts?.orchestrator !== false && !exists) {
            console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${tmuxTarget}`);
          } else if (exists) {
            console.log(chalk.cyan("Orchestrator:"), `already running (${sessionId})`);
          }

          console.log(chalk.dim(`Config: ${config.configPath}\n`));

          // Keep dashboard process alive if it was started
          if (dashboardProcess) {
            dashboardProcess.on("exit", (code) => {
              if (code !== 0 && code !== null) {
                console.error(chalk.red(`Dashboard exited with code ${code}`));
              }
              process.exit(code ?? 0);
            });
          }
        } catch (err) {
          if (err instanceof Error) {
            if (err.message.includes("No agent-orchestrator.yaml found")) {
              console.error(chalk.red("\nNo config found. Run:"));
              console.error(chalk.cyan("  ao init\n"));
            } else {
              console.error(chalk.red("\nError:"), err.message);
            }
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard for a project")
    .action(async (projectArg?: string) => {
      try {
        const config = loadConfig();
        const { projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix}-orchestrator`;
        const port = config.port ?? 3000;

        console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

        // Kill orchestrator session via SessionManager
        const sm = await getSessionManager(config);
        const existing = await sm.get(sessionId);

        if (existing) {
          const spinner = ora("Stopping orchestrator session").start();
          await sm.kill(sessionId);
          spinner.succeed("Orchestrator session stopped");
        } else {
          console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
        }

        // A4: Stop dashboard + terminal WS servers via run state
        const runState = config.configPath
          ? readRunState(config.configPath, projectId)
          : null;

        if (runState) {
          // Verify PID liveness before killing
          let pidAlive = false;
          try {
            process.kill(runState.pgid, 0); // signal 0 = check existence
            pidAlive = true;
          } catch {
            // PID doesn't exist — stale run state
          }

          if (pidAlive) {
            try {
              // Kill process group (dashboard + all terminal WS children)
              process.kill(-runState.pgid, "SIGTERM");
              console.log(chalk.green(`Dashboard stopped (process group ${runState.pgid})`));
            } catch {
              console.log(chalk.yellow("Could not stop dashboard process group (may already be stopped)"));
            }
          } else {
            console.log(chalk.yellow("Dashboard PID is stale — already stopped"));
          }
          if (config.configPath) {
            deleteRunState(config.configPath, projectId);
          }
        } else {
          // Legacy fallback: no run state file — try lsof on configured port
          console.log(chalk.dim("No run state found — falling back to port-based cleanup"));
          await stopDashboard(port);
        }

        console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}
