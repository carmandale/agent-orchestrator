/**
 * `ao project add` command — register a new project in agent-orchestrator.yaml.
 *
 * Validates inputs (repo format, path exists, no duplicates, no collisions),
 * then writes the project entry using yaml parseDocument to preserve comments.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import type { Command } from "commander";
import { parseDocument, parse as parseYaml } from "yaml";
import {
  loadConfigWithPath,
  validateConfig,
  expandHome,
} from "@composio/ao-core";
import { detectDefaultBranch } from "../lib/git-utils.js";

const execFileAsync = promisify(execFileCb);

const REPO_FORMAT_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function registerProjectAdd(program: Command): void {
  const projectCmd = program.commands.find((c) => c.name() === "project") ??
    program.command("project").description("Manage projects");

  projectCmd
    .command("add <name>")
    .description("Register a new project in agent-orchestrator.yaml")
    .requiredOption("--repo <owner/repo>", "GitHub repo (owner/repo format)")
    .requiredOption("--path <local-path>", "Local path to the repo")
    .option("--branch <branch>", "Default branch (default: main)")
    .option("--session-prefix <prefix>", "Session name prefix")
    .option("--agent <agent>", "Override default agent plugin")
    .option("--agent-permissions <mode>", "Agent permissions (skip or default)")
    .action(
      async (
        name: string,
        opts: {
          repo: string;
          path: string;
          branch?: string;
          sessionPrefix?: string;
          agent?: string;
          agentPermissions?: string;
        },
      ) => {
        try {
          const { repo, path: rawPath, branch, sessionPrefix, agent, agentPermissions } = opts;

          // 1. Validate repo format
          if (!REPO_FORMAT_RE.test(repo)) {
            throw new Error(`Invalid repo format: "${repo}". Expected: owner/repo`);
          }

          // 2. Best-effort GitHub repo check
          try {
            await execFileAsync("gh", ["--version"], { timeout: 5_000 });
            await execFileAsync("gh", ["repo", "view", repo, "--json", "name"], {
              timeout: 10_000,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("ENOENT") || msg.includes("not found")) {
              // gh CLI not installed — skip silently
            } else {
              console.warn(
                chalk.yellow(
                  `Warning: could not verify repo "${repo}" on GitHub (may not exist yet)`,
                ),
              );
            }
          }

          // 3. Validate path exists and is a git repository
          const expandedPath = expandHome(rawPath);
          if (!existsSync(expandedPath)) {
            throw new Error(`Path does not exist: ${expandedPath}`);
          }
          const pathStat = statSync(expandedPath);
          if (!pathStat.isDirectory()) {
            throw new Error(`Path is not a directory: ${expandedPath}`);
          }
          try {
            const { stdout } = await execFileAsync(
              "git", ["-C", expandedPath, "rev-parse", "--is-inside-work-tree"],
              { timeout: 10_000 },
            );
            if (stdout.trim() !== "true") {
              throw new Error(`Path is not inside a git work tree: ${expandedPath}`);
            }
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes("not inside a git work tree")) throw err;
            throw new Error(`Path is not a git repository: ${expandedPath}`);
          }

          // 4. Auto-detect default branch (user's --branch flag takes precedence)
          const detectedBranch = branch ?? await detectDefaultBranch(expandedPath);

          // 5. Load config and check for duplicate name
          const { config, path: configPath } = loadConfigWithPath();
          if (config.projects[name]) {
            throw new Error(`Project "${name}" already exists in config`);
          }

          // 6. Full config validation (catches basename + sessionPrefix collisions)
          const rawYaml = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          const rawProjects = (rawYaml.projects ?? {}) as Record<string, unknown>;
          const rawNewProject: Record<string, unknown> = { repo, path: rawPath };
          rawNewProject.defaultBranch = detectedBranch;
          if (sessionPrefix) rawNewProject.sessionPrefix = sessionPrefix;
          if (agent) rawNewProject.agent = agent;
          if (agentPermissions) rawNewProject.agentConfig = { permissions: agentPermissions };
          rawProjects[name] = rawNewProject;
          rawYaml.projects = rawProjects;
          validateConfig(rawYaml);

          // 7. Write using parseDocument (preserves comments and formatting)
          const doc = parseDocument(readFileSync(configPath, "utf-8"));
          const projectsNode = doc.get("projects", true);
          if (!projectsNode || typeof projectsNode !== "object") {
            throw new Error("Could not find 'projects' key in config file");
          }

          const projectEntry: Record<string, unknown> = {
            repo,
            path: rawPath,
            defaultBranch: detectedBranch,
          };
          if (sessionPrefix) projectEntry.sessionPrefix = sessionPrefix;
          if (agent) projectEntry.agent = agent;
          if (agentPermissions) projectEntry.agentConfig = { permissions: agentPermissions };

          doc.setIn(["projects", name], doc.createNode(projectEntry));
          writeFileSync(configPath, doc.toString(), "utf-8");

          // 8. Print confirmation
          const validated = validateConfig(
            parseYaml(readFileSync(configPath, "utf-8")),
          );
          const addedProject = validated.projects[name];

          console.log(chalk.bold.green(`\nProject "${name}" added successfully\n`));
          console.log(chalk.cyan("  Name:"), addedProject.name);
          console.log(chalk.cyan("  Repo:"), addedProject.repo);
          console.log(chalk.cyan("  Path:"), addedProject.path);
          console.log(chalk.cyan("  Branch:"), addedProject.defaultBranch);
          console.log(chalk.cyan("  Session Prefix:"), addedProject.sessionPrefix);
          if (addedProject.agent) {
            console.log(chalk.cyan("  Agent:"), addedProject.agent);
          }
          console.log();
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
