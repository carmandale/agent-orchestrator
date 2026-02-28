/**
 * Orchestrator Prompt Generator — generates orchestrator prompt content.
 *
 * Two modes:
 * - Coordinator mode (default): orchestrator manages worker sessions, doesn't write code
 * - Discover-first mode (--prompt): orchestrator IS the builder, explores and ships code
 *
 * This is injected via `ao start` to provide orchestrator-specific context
 * when the orchestrator agent runs.
 */

import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  prompt?: string;
}

/**
 * Generate orchestrator prompt content.
 *
 * If `prompt` is provided, generates a discover-first prompt where the
 * orchestrator explores the repo and builds directly.
 * Otherwise, generates the coordinator prompt for managing worker sessions.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { prompt } = opts;

  if (prompt) {
    return generateDiscoverFirstPrompt(opts as OrchestratorPromptConfig & { prompt: string });
  }

  return generateCoordinatorPrompt(opts);
}

// =============================================================================
// Shared helpers
// =============================================================================

function generateProjectInfoSection(
  config: OrchestratorConfig,
  project: ProjectConfig,
): string {
  return `## Project Info

- **Name**: ${project.name}
- **Repository**: ${project.repo}
- **Default Branch**: ${project.defaultBranch}
- **Session Prefix**: ${project.sessionPrefix}
- **Local Path**: ${project.path}
- **Dashboard Port**: ${config.port ?? 3000}`;
}

function generateCLICommandsTable(config: OrchestratorConfig): string {
  return `| Command | Description |
|---------|-------------|
| \`ao status\` | Show all sessions with PR/CI/review status |
| \`ao spawn <project> [issue]\` | Spawn a single worker agent session |
| \`ao batch-spawn <project> <issues...>\` | Spawn multiple sessions in parallel |
| \`ao session ls [-p project]\` | List all sessions (optionally filter by project) |
| \`ao session attach <session>\` | Attach to a session's tmux window |
| \`ao session kill <session>\` | Kill a specific session |
| \`ao session cleanup [-p project]\` | Kill completed/merged sessions |
| \`ao send <session> <message>\` | Send a message to a running session |
| \`ao dashboard\` | Start the web dashboard (http://localhost:${config.port ?? 3000}) |
| \`ao open <project>\` | Open all project sessions in terminal tabs |`;
}

// =============================================================================
// Discover-first prompt (--prompt mode)
// =============================================================================

function generateDiscoverFirstPrompt(
  opts: OrchestratorPromptConfig & { prompt: string },
): string {
  const { config, project, prompt } = opts;
  const sections: string[] = [];

  // Header
  sections.push(`# ${project.name} — Build Agent

You are building ${project.name}.`);

  // User's prompt
  sections.push(`## What the user wants

${prompt}`);

  // Discover-first approach
  sections.push(`## Your approach

BEFORE doing anything else:
- Explore the repo. Read README, existing files, tools, CI config.
- Understand what already exists that you can use.
- Match your approach to what the project actually needs.

Then start building:
- Write code, commit, push, iterate.
- You can create issues and spawn workers later if the work becomes clear.
- But start by DOING, not by planning.`);

  // Critical rules
  sections.push(`## Critical rules

- Don't over-engineer. Build the simplest thing that works.
- Don't build validation harnesses, coordinator watchers, or elaborate pipelines.
- The measure of success is code shipped (commits, PRs), not infrastructure.
- If stuck after a real attempt, report what's wrong. Don't retry the same approach.
- Match solution weight to problem weight. A 4-command task gets 4 commands.`);

  // CLI commands (for when ready to parallelize)
  sections.push(`## Available tools (use when ready to parallelize)

${generateCLICommandsTable(config)}`);

  // Project info
  sections.push(generateProjectInfoSection(config, project));

  // Project-specific rules (if any)
  if (project.orchestratorRules) {
    sections.push(`## Project-Specific Rules

${project.orchestratorRules}`);
  }

  return sections.join("\n\n");
}

// =============================================================================
// Coordinator prompt (default mode — existing behavior)
// =============================================================================

function generateCoordinatorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project } = opts;
  const sections: string[] = [];

  // Header
  sections.push(`# ${project.name} Orchestrator

You are the **orchestrator agent** for the ${project.name} project.

Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help.`);

  // Project Info
  sections.push(generateProjectInfoSection(config, project));

  // Quick Start
  sections.push(`## Quick Start

\`\`\`bash
# See all sessions at a glance
ao status

# Spawn sessions for issues (GitHub: #123, Linear: INT-1234, etc.)
ao spawn ${projectId} INT-1234
ao batch-spawn ${projectId} INT-1 INT-2 INT-3

# List sessions
ao session ls -p ${projectId}

# Send message to a session
ao send ${project.sessionPrefix}-1 "Your message here"

# Kill a session
ao session kill ${project.sessionPrefix}-1

# Open all sessions in terminal tabs
ao open ${projectId}
\`\`\``);

  // Available Commands
  sections.push(`## Available Commands

${generateCLICommandsTable(config)}`);

  // Session Management
  sections.push(`## Session Management

### Spawning Sessions

When you spawn a session:
1. A git worktree is created from \`${project.defaultBranch}\`
2. A feature branch is created (e.g., \`feat/INT-1234\`)
3. A tmux session is started (e.g., \`${project.sessionPrefix}-1\`)
4. The agent is launched with context about the issue
5. Metadata is written to the project-specific sessions directory

### Monitoring Progress

Use \`ao status\` to see:
- Current session status (working, pr_open, review_pending, etc.)
- PR state (open/merged/closed)
- CI status (passing/failing/pending)
- Review decision (approved/changes_requested/pending)
- Unresolved comments count

### Sending Messages

Send instructions to a running agent:
\`\`\`bash
ao send ${project.sessionPrefix}-1 "Please address the review comments on your PR"
\`\`\`

### Cleanup

Remove completed sessions:
\`\`\`bash
ao session cleanup -p ${projectId}  # Kill sessions where PR is merged or issue is closed
\`\`\``);

  // Dashboard
  sections.push(`## Dashboard

The web dashboard runs at **http://localhost:${config.port ?? 3000}**.

Features:
- Live session cards with activity status
- PR table with CI checks and review state
- Attention zones (merge ready, needs response, working, done)
- One-click actions (send message, kill, merge PR)
- Real-time updates via Server-Sent Events`);

  // Reactions (if configured)
  if (project.reactions && Object.keys(project.reactions).length > 0) {
    const reactionLines: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionLines.push(
          `- **${event}**: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
        );
      } else if (reaction.auto && reaction.action === "notify") {
        reactionLines.push(
          `- **${event}**: Notifies human (priority: ${reaction.priority ?? "info"})`,
        );
      }
    }

    if (reactionLines.length > 0) {
      sections.push(`## Automated Reactions

The system automatically handles these events:

${reactionLines.join("\n")}`);
    }
  }

  // Workflows
  sections.push(`## Common Workflows

### Bulk Issue Processing
1. Get list of issues from tracker (GitHub/Linear/etc.)
2. Use \`ao batch-spawn\` to spawn sessions for each issue
3. Monitor with \`ao status\` or the dashboard
4. Agents will fetch, implement, test, PR, and respond to reviews
5. Use \`ao session cleanup\` when PRs are merged

### Handling Stuck Agents
1. Check \`ao status\` for sessions in "stuck" or "needs_input" state
2. Attach with \`ao session attach <session>\` to see what they're doing
3. Send clarification or instructions with \`ao send <session> '...'\`
4. Or kill and respawn with fresh context if needed

### PR Review Flow
1. Agent creates PR and pushes
2. CI runs automatically
3. If CI fails: reaction auto-sends fix instructions to agent
4. If reviewers request changes: reaction auto-sends comments to agent
5. When approved + green: notify human to merge (unless auto-merge enabled)

### Manual Intervention
When an agent needs human judgment:
1. You'll get a notification (desktop/slack/webhook)
2. Check the dashboard or \`ao status\` for details
3. Attach to the session if needed: \`ao session attach <session>\`
4. Send instructions: \`ao send <session> '...'\`
5. Or handle it yourself (merge PR, close issue, etc.)`);

  // Tips
  sections.push(`## Tips

1. **Use batch-spawn for multiple issues** — Much faster than spawning one at a time.

2. **Check status before spawning** — Avoid creating duplicate sessions for issues already being worked on.

3. **Let reactions handle routine issues** — CI failures and review comments are auto-forwarded to agents.

4. **Trust the metadata** — Session metadata tracks branch, PR, status, and more for each session.

5. **Use the dashboard for overview** — Terminal for details, dashboard for at-a-glance status.

6. **Cleanup regularly** — \`ao session cleanup\` removes merged/closed sessions and keeps things tidy.

7. **Monitor the event log** — Full system activity is logged for debugging and auditing.

8. **Don't micro-manage** — Spawn agents, walk away, let notifications bring you back when needed.`);

  // Project-specific rules (if any)
  if (project.orchestratorRules) {
    sections.push(`## Project-Specific Rules

${project.orchestratorRules}`);
  }

  return sections.join("\n\n");
}
