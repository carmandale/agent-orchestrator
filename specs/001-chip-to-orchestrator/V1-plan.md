---
shaping: true
---

# V1 Plan: Chip Can Start a Build from a Rough Idea

## User Story

> Chip registers a project and starts a build with an inline prompt. An orchestrator agent launches, explores the repo, and starts building.

## Demo

```bash
# Chip registers the project
ao project add my-new-app \
  --repo carmandale/my-new-app \
  --path ~/my-new-app \
  --branch main \
  --session-prefix app \
  --agent codex \
  --agent-permissions skip

# Chip starts the build
ao start my-new-app --prompt "Build a todo app with auth and a nice dashboard"
```

Result: orchestrator agent launches in tmux, receives discover-first prompt, explores the repo, starts building.

---

## What Exists Today

| Piece | Status | Where |
|-------|--------|-------|
| `ao start [project]` | Exists — starts orchestrator + dashboard | `packages/cli/src/commands/start.ts` |
| `generateOrchestratorPrompt()` | Exists — generates generic orchestrator prompt | `packages/core/src/orchestrator-prompt.ts` |
| Config loader (YAML → Zod) | Exists — reads `agent-orchestrator.yaml` | `packages/core/src/config.ts` |
| Session manager (spawn orchestrator) | Exists — `sm.spawnOrchestrator()` | `packages/core/src/session-manager.ts` |
| Plugin system (tmux, claude-code, worktree) | Exists | `packages/plugins/` |
| `ao spawn`, `ao status`, `ao send`, `ao session kill` | Exist | `packages/cli/src/commands/` |

## What We Build

Two things:

1. **`ao project add`** — new CLI command that writes a project entry to `agent-orchestrator.yaml`
2. **`ao start --prompt`** — new flag on existing command + discover-first orchestrator prompt

---

## Task 1: `ao project add` CLI command

**File: `packages/cli/src/commands/project-add.ts`** (new)

Programmatic equivalent of manually editing `agent-orchestrator.yaml`. Chip calls this to register a new project.

### Interface

```bash
ao project add <name> \
  --repo <owner/repo>           # required
  --path <local-path>           # required
  --branch <default-branch>     # optional, default: main
  --session-prefix <prefix>     # optional, derived from name
  --agent <agent-name>          # optional, default: from config defaults
  --agent-permissions <mode>    # optional, sets agentConfig.permissions
```

### Behavior

1. Load existing config via `loadConfigWithPath()` — need the file path to write back
2. Validate:
   - `--repo` looks like `owner/repo`
   - `--path` exists on disk (expand `~`)
   - `name` doesn't already exist in config
3. Build project entry object matching `ProjectConfigSchema`
4. Read raw YAML file content (preserve formatting, comments)
5. Append new project under `projects:` key
6. Write back to same file path
7. Print confirmation: project name, repo, path, session prefix

### YAML Writing Strategy

Don't parse-and-serialize the whole file (destroys comments and formatting). Instead:

- Use the `yaml` package's `parseDocument()` (preserves structure) to get a mutable document
- Set the new project key on the `projects` map node
- Call `doc.toString()` to serialize back with preserved formatting

Note: `ao init` currently uses `yaml.stringify()` (full serialization). We use `parseDocument()` here because `project add` modifies an existing file that may have user comments, while `init` creates a new file from scratch. The `yaml` package (already a dependency) supports both approaches.

### Validation Details

```typescript
// 1. repo format
if (!repo.match(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)) {
  throw new Error(`Invalid repo format: "${repo}". Expected: owner/repo`);
}

// 2. repo exists on GitHub (best-effort — warn, don't block)
// Repo may not exist yet if Chip is creating it concurrently.
// Also: gh CLI may not be installed or authenticated — handle gracefully.
try {
  // First check if gh is available
  await execFileAsync("gh", ["--version"], { timeout: 5_000 });
  // Then check repo
  await execFileAsync("gh", ["repo", "view", repo, "--json", "name"], { timeout: 10_000 });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ENOENT") || msg.includes("not found")) {
    // gh CLI not installed — skip check silently
  } else {
    console.warn(`Warning: could not verify repo "${repo}" on GitHub (may not exist yet)`);
  }
}

// 3. path exists
const expandedPath = expandHome(path);
if (!existsSync(expandedPath)) {
  throw new Error(`Path does not exist: ${expandedPath}`);
}

// 4. name not duplicate
const config = loadConfig(configPath);
if (config.projects[name]) {
  throw new Error(`Project "${name}" already exists in config`);
}

// 5. full config validation (catches basename + sessionPrefix collisions)
// We need to validate against the RAW (pre-Zod) config, not the validated one,
// because validateConfig() runs Zod parsing + expandPaths + applyDefaults.
// Strategy: re-read the YAML file as raw object, inject the new project as raw
// values (not validated objects), then run validateConfig() on the whole thing.
const rawYaml = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
const rawProjects = (rawYaml.projects ?? {}) as Record<string, unknown>;
const rawNewProject: Record<string, unknown> = { repo, path };
if (branch) rawNewProject.defaultBranch = branch;
if (sessionPrefix) rawNewProject.sessionPrefix = sessionPrefix;
if (agent) rawNewProject.agent = agent;
if (agentPermissions) rawNewProject.agentConfig = { permissions: agentPermissions };
rawProjects[name] = rawNewProject;
rawYaml.projects = rawProjects;
validateConfig(rawYaml); // throws on basename/prefix collision with friendly error
```

### Registration in CLI

**File: `packages/cli/src/index.ts`** (edit)

```typescript
import { registerProjectAdd } from "./commands/project-add.js";
registerProjectAdd(program);
```

---

## Task 2: `ao start --prompt` flag + discover-first prompt

### 2a: Add `--prompt` flag to `ao start`

**File: `packages/cli/src/commands/start.ts`** (edit)

Add `--prompt <text>` option to the start command. When provided, pass it to the orchestrator prompt generator.

```typescript
.option("--prompt <text>", "Start with an inline prompt (rough idea mode)")
```

**Conflict with existing orchestrator session:** The current `ao start` skips spawn if the orchestrator session already exists (line 199–209 of `start.ts`). If `--prompt` is provided but the session already exists, the prompt is silently ignored — the user thinks they started a new build but nothing changed.

Fix: when `--prompt` is provided and the orchestrator session already exists, error with guidance.

Why "error" instead of `--restart-orchestrator` flag: Chip is calling this programmatically. An explicit stop-then-start is clearer than a magic flag that silently kills a running session. Chip can handle a two-step flow; a hidden restart risks killing work in progress. If this proves too friction-heavy in practice, we can add `--restart` in a follow-up — but start conservative.

```typescript
if (exists && opts.prompt) {
  throw new Error(
    `Orchestrator session "${sessionId}" is already running.\n` +
    `To start with a new prompt, stop the existing session first:\n` +
    `  ao stop ${projectArg ?? ""}\n` +
    `  ao start ${projectArg ?? ""} --prompt "..."`
  );
}
```

In the action handler (when no conflict), pass the prompt to `generateOrchestratorPrompt()`:

```typescript
const systemPrompt = generateOrchestratorPrompt({
  config,
  projectId,
  project,
  prompt: opts.prompt,  // new field
});
```

### 2b: Update orchestrator prompt generator

**File: `packages/core/src/orchestrator-prompt.ts`** (edit)

Add `prompt?: string` to `OrchestratorPromptConfig`. When a prompt is provided, the orchestrator gets the **discover-first prompt** instead of the generic coordinator prompt.

The key change: the current prompt says "You do NOT write code yourself — you spawn worker agents." With `--prompt`, the orchestrator IS the builder (at least initially). It can spawn workers later when the shape of the work becomes clear.

**Current prompt structure (keep for no-prompt mode):**
```
# {project.name} Orchestrator
You are the orchestrator agent... You do NOT write code yourself...
[CLI commands, session management, workflows, tips]
```

**New prompt structure (when --prompt is provided):**
```
# {project.name} — Build Agent

You are building {project.name}.

## What the user wants
{prompt text}

## Your approach
BEFORE doing anything else:
- Explore the repo. Read README, existing files, tools, CI config.
- Understand what already exists that you can use.
- Match your approach to what the project actually needs.

Then start building:
- Write code, commit, push, iterate
- You can create issues and spawn workers later if the work becomes clear
- But start by DOING, not by planning

## Critical rules
- Don't over-engineer. Build the simplest thing that works.
- Don't build validation harnesses, coordinator watchers, or elaborate pipelines.
- The measure of success is code shipped (commits, PRs), not infrastructure.
- If stuck after a real attempt, report what's wrong. Don't retry the same approach.
- Match solution weight to problem weight. A 4-command task gets 4 commands.

## Available tools (use when ready to parallelize)
[CLI commands table — ao spawn, ao status, etc.]

## Project info
[repo, branch, path, etc.]
```

### Implementation detail

The function keeps its existing structure (sections array, join at end) but branches based on whether `prompt` is provided:

```typescript
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project, prompt } = opts;

  if (prompt) {
    return generateDiscoverFirstPrompt({ config, projectId, project, prompt });
  }

  // Existing coordinator prompt (unchanged)
  return generateCoordinatorPrompt({ config, projectId, project });
}
```

Extract the existing logic into `generateCoordinatorPrompt()` (rename, no behavior change). Add `generateDiscoverFirstPrompt()` as a new private function.

### 2c: Export the updated type

**File: `packages/core/src/orchestrator-prompt.ts`** (edit)

```typescript
export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  prompt?: string;  // new — inline prompt for rough-idea mode
}
```

No changes needed to `packages/core/src/index.ts` — already exports `OrchestratorPromptConfig`.

---

## Task 3: Tests

### 3a: `ao project add` tests

**File: `packages/cli/__tests__/commands/project-add.test.ts`** (new)

Note: CLI vitest config includes top-level `__tests__/` paths, not `src/commands/__tests__/`.

- Adds project to YAML file correctly
- Validates repo format (rejects bad format)
- Validates path exists (rejects nonexistent)
- Rejects duplicate project name
- Rejects sessionPrefix/basename collision (full config validation)
- Handles optional flags (branch, session-prefix, agent)
- Preserves existing YAML content and comments

### 3b: Orchestrator prompt tests

**File: `packages/core/src/__tests__/orchestrator-prompt.test.ts`** (new)

Note: Core tests live at `packages/core/src/__tests__/` (established pattern — 9 existing test files there). One outlier exists at `packages/core/__tests__/config.test.ts` but we follow the majority convention.

- Without `--prompt`: generates coordinator prompt (existing behavior, regression test)
- With `--prompt`: generates discover-first prompt with user's text
- Discover-first prompt includes critical rules (don't over-engineer, match weight)
- Discover-first prompt includes project info and CLI commands
- Discover-first prompt does NOT say "you do NOT write code yourself"

### 3c: `ao start --prompt` conflict test

- With `--prompt` and existing orchestrator session → error with stop/restart guidance
- Without `--prompt` and existing session → existing behavior (skip, no error)

---

## Task Order

```
1. ao project add        — new command, self-contained
2. ao start --prompt     — new flag + prompt refactor
3. Tests                 — validate both pieces
4. Manual smoke test     — run the two-command flow end-to-end
```

Tasks 1 and 2 are independent (can be built in parallel). Task 3 depends on both. Task 4 depends on 3.

### Task 4: Smoke Test Acceptance Criteria

The smoke test must verify that the discover-first prompt produces the right agent behavior, not just that the CLI plumbing works. Run against a real (or test) repo:

1. **Agent explores first** — within first 2 minutes, agent reads README or runs `ls`/`find` to understand the repo (visible in tmux output)
2. **Agent ships code** — at least one commit within 10 minutes
3. **No harness anti-pattern** — agent does NOT create bash scripts > 50 lines, coordinator watchers, structured comment parsers, or preflight checklists
4. **Weight matches** — if the prompt is a simple task ("add a hello world endpoint"), the agent's response is proportionally simple

If the agent builds infrastructure instead of shipping code, the prompt needs iteration. This is expected — the prompt is the product and will likely need 2-3 rounds.

---

## Files Touched

| File | Change |
|------|--------|
| `packages/cli/src/commands/project-add.ts` | **New** — `ao project add` command |
| `packages/cli/src/index.ts` | **Edit** — register new command |
| `packages/cli/src/commands/start.ts` | **Edit** — add `--prompt` option + existing-session conflict check |
| `packages/core/src/orchestrator-prompt.ts` | **Edit** — add `prompt` field, extract functions, add discover-first prompt |
| `packages/cli/__tests__/commands/project-add.test.ts` | **New** — tests |
| `packages/core/src/__tests__/orchestrator-prompt.test.ts` | **New** — tests |

---

## What V1 Does NOT Do

- No spec auto-detection (that's V2)
- No adaptive mode selection (that's V2)
- No webhook to Chip (that's V3, uses existing desktop notifier for now)
- No anti-churn guardrails (that's V3, prompt is the only defense)
- No `--from-spec` flag (that's V2)

---

## Note: Prompt Persistence

The orchestrator system prompt (including the user's `--prompt` text) is written to disk by `spawnOrchestrator()` at `~/.agent-orchestrator/{hash}/{projectId}/orchestrator-prompt.md`. This file persists after the session ends and survives `ao session cleanup`.

For V1 this is acceptable — rough prompts ("Build a todo app with auth") don't contain sensitive data. If V3 introduces webhook payloads or user credentials in prompts, revisit with a cleanup/redaction policy.

---

## Risk: The Prompt Is the Product

V1's success depends entirely on whether the discover-first prompt produces an agent that actually explores and builds, rather than building harnesses. This is the A3 insight from shaping.

The prompt can't be validated in unit tests — it needs a real smoke test against a real repo. Task 4 (manual smoke test) is where we find out if the prompt works. If the agent builds a 200-line bash script instead of running 4 commands, the prompt needs iteration.

This is expected. The prompt is the most important piece and will likely need 2-3 iterations based on real behavior.
