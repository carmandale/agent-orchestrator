---
shaping: true
bead: agent-orchestrator-3
---

# V1 Hardening — Bulletproof the Chip-to-Orchestrator Pipeline

## Source

V1 (spec 001) works end-to-end: Chip can register a project, start an orchestrator, and agents spawn. But the first real smoke test exposed 8 gaps that required manual intervention. Each gap is a place where the pipeline silently fails or misleads, forcing Chip (or the human behind Chip) to debug instead of walk away.

**Smoke test transcript (condensed):**

> 1. `ao start my-app` — orchestrator agent launched, immediately sat at Claude Code permission prompt. Nobody there to approve. Session hung until manual `ctrl-C`.
>
> 2. `ao project add foo --repo org/foo --path /tmp/not-a-repo` — accepted the path (directory exists, but no `.git`). Later `ao start foo` failed deep in workspace creation with a cryptic git error.
>
> 3. Config had no `defaultBranch` set. System defaulted to `"main"`. Repo used `"master"`. Orchestrator created worktree on wrong branch, diverged from trunk.
>
> 4. Port 3000 already in use by another dev server. `ao start` launched dashboard, which failed silently. No error message, no fallback, dashboard just not there.
>
> 5. `ao stop my-app` killed the orchestrator tmux session and the dashboard process on port 3000. But terminal WebSocket servers on ports 14800/14801 survived. Next `ao start` couldn't bind those ports → dashboard partially broken.
>
> 6. Project path in config pointed to a directory that had been deleted between sessions. `ao start` didn't check — spawned orchestrator, which failed in workspace plugin with an opaque error about missing directory.
>
> 7. Set `AO_CONFIG_PATH=~/agent-orchestrator.yaml` in shell profile. Config loader called `resolve("~/agent-orchestrator.yaml")` which resolved to `$CWD/~/agent-orchestrator.yaml` — wrong path. Failed silently, fell back to default search.
>
> 8. Agent process exited (Claude Code finished its work), but tmux session stayed alive. Status page showed "exited" activity. But the session was "running" in tmux, and the lifecycle manager kept polling it. Misleading — looked broken when it was actually done.

**Goal:** After these fixes, Chip runs `ao project add` + `ao start`, walks away. It works every time. No disclaimers.

---

## Requirements (R)

| ID | Requirement | Priority |
|----|-------------|----------|
| R0 | Agent sessions must start unattended — no interactive prompts blocking startup | Must-have |
| R1 | `ao project add` must reject non-git directories at registration time | Must-have |
| R2 | Default branch must be auto-detected from the repo, not hardcoded to `"main"` | Must-have |
| R3 | Dashboard must detect port collision and either find an available port or fail clearly | Must-have |
| R4 | `ao stop` must clean up ALL spawned processes including terminal WS servers | Must-have |
| R5 | `ao start` must validate project path exists before spawning anything | Must-have |
| R6 | `AO_CONFIG_PATH` must expand `~` to home directory and fail loudly if invalid | Must-have |
| R7 | When agent process exits but tmux session stays, status must reflect "completed" not ambiguous "exited while running" | Must-have |

---

## Shape A: Systematic Fixes

Each part maps 1:1 to a requirement. A3 and A4 are coupled (shared run state file) but each addresses a distinct requirement.

### A0: Default `permissions: skip` for Unattended Sessions

**Problem:** `AgentSpecificConfig.permissions` is optional with no default (`packages/core/src/types.ts:931`). When not set, Claude Code launches in interactive permission mode — prompts for approval, blocks forever in unattended sessions. Additionally, `getAgentConfig()` in `session-manager.ts:276` merges optional config objects via spread — if none of the layers set `permissions`, the merged result still has no `permissions` field even with a Zod default, because the Zod schema only applies at parse time, not at merge time.

**Mechanism:** Two layers of defense:

1. **Zod schema default** — `packages/core/src/config.ts`: add `.default("skip")` to the `permissions` field in `AgentSpecificConfig` schema. Catches config parsed from YAML.

2. **Runtime fallback** — `packages/core/src/session-manager.ts` in `getAgentConfig()`: after the spread merge, add `permissions ??= "skip"` as the final fallback. Catches cases where all config layers are empty/undefined.

```typescript
// In getAgentConfig(), after the spread merge (both worker and orchestrator paths):
function getAgentConfig(project: ProjectConfig, role: AgentRole): AgentSpecificConfig {
  const defaultCommon = config.defaults.agentConfig ?? {};
  const projectCommon = project.agentConfig ?? {};

  let merged: AgentSpecificConfig;
  if (role === "orchestrator") {
    merged = {
      ...defaultCommon,
      ...(config.defaults.orchestratorAgentConfig ?? {}),
      ...projectCommon,
      ...(project.orchestratorAgentConfig ?? {}),
    };
  } else {
    merged = { ...defaultCommon, ...projectCommon };
  }

  // Belt-and-suspenders: ensure unattended sessions never block on permissions
  merged.permissions ??= "skip";
  return merged;
}
```

**Where:**
- `packages/core/src/config.ts` — Zod schema default
- `packages/core/src/session-manager.ts:276-293` — runtime fallback in both worker and orchestrator code paths

**Scope:** ~5 lines across 2 files.

**Tests:** Add tests in `session-manager.test.ts`:
- Spawn worker with no permissions config → launch command includes `--dangerously-skip-permissions`
- Spawn orchestrator with no permissions config → launch command includes `--dangerously-skip-permissions`
- Explicit `permissions: "default"` in config → respected (not overridden by fallback)

---

### A1: Validate Git Repo in `ao project add`

**Problem:** `project-add.ts:77-80` validates path exists (`existsSync`) but not that it's a git repository. Non-git paths are accepted, then fail later during workspace creation with opaque errors.

**Mechanism:** After the `existsSync` check, run `git -C <path> rev-parse --is-inside-work-tree` using `execFileAsync`. This is authoritative (handles bare repos, submodules, worktrees) unlike a `.git` directory check. Assert that stdout is exactly `"true"` — edge cases can produce different output. Also assert path is a directory (not a file).

**Where:** `packages/cli/src/commands/project-add.ts`, after line 80:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
const execFileAsync = promisify(execFile);

// After existsSync check:
const stat = statSync(expandedPath);
if (!stat.isDirectory()) {
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
```

**Scope:** ~15 lines in one file.

**Tests:** Add tests in `project-add.test.ts`:
- Non-git directory → error with "not a git repository"
- File path → error with "not a directory"
- Valid git repo → succeeds
- Git repo subdirectory → succeeds (rev-parse returns "true" for subdirs too)

---

### A2: Auto-Detect Default Branch at Registration Time

**Problem:** `config.ts:66` hardcodes `defaultBranch: z.string().default("main")`. Repos using `"master"` get the wrong default. Orchestrator creates worktrees on wrong branch.

**Mechanism:** Detect the default branch at **registration time** (`ao project add`), not at runtime. This keeps `defaultBranch` as a required `string` field in `ProjectConfig` (the Zod `.default("main")` stays as a parse-time fallback for legacy configs). The detection logic runs during `ao project add` and persists the result in the YAML.

Detection cascade:
1. `git -C <projectPath> symbolic-ref refs/remotes/origin/HEAD` → parse branch name (e.g. `refs/remotes/origin/main` → `main`)
2. Fallback: `git -C <projectPath> rev-parse --abbrev-ref HEAD` → use current branch
3. Final fallback: `"main"` (existing Zod default)

**Legacy config handling:** For configs that predate this fix and lack an explicit `defaultBranch`, the Zod `.default("main")` applies at parse time. To detect this at startup and warn the user, use `loadConfigWithPath()` (`config.ts:387`) to get the config file path, then read the raw YAML and check whether `projects[projectName].defaultBranch` is present as a key before Zod normalization:

```typescript
// In ao start, after loading config:
import { readFileSync } from "node:fs";
import YAML from "yaml";

const { config, path: configPath } = loadConfigWithPath();
const rawYaml = YAML.parse(readFileSync(configPath, "utf-8"));
const rawProject = rawYaml?.projects?.[projectName];
if (rawProject && !("defaultBranch" in rawProject)) {
  console.warn(
    `⚠ Project "${projectName}" has no explicit defaultBranch — defaulting to "main".\n` +
    `  Run "ao project add" again or set defaultBranch in config to fix.`,
  );
}
```

This is a warning, not an error — it doesn't block startup, just alerts the user.

**Where:**
- New utility function `detectDefaultBranch(projectPath: string): Promise<string>` in `packages/cli/src/lib/git-utils.ts`
- `packages/cli/src/commands/project-add.ts` — call `detectDefaultBranch()` during registration, write result to config. User's `--branch` flag takes precedence.
- `packages/cli/src/commands/start.ts` — detect Zod-defaulted branch via raw YAML key check, emit warning
- `packages/core/src/config.ts` — **no schema change**. `.default("main")` stays.

**Scope:** ~25 lines of detection logic + ~10 lines for legacy warning.

**Tests:** Add tests:
- Register a repo using "master" without `--branch` → config has `defaultBranch: "master"`
- Register with explicit `--branch develop` → config has `defaultBranch: "develop"`
- `ao start` with Zod-defaulted defaultBranch → warning emitted

---

### A3+A4: Dashboard Port Collision + Process Cleanup via Run State

**Problem (R3):** Dashboard launches on `config.port ?? 3000` without checking availability (`start.ts:145`). If port is taken, Next.js fails silently — no dashboard, no error.

**Problem (R4):** `ao stop` kills the orchestrator session and dashboard process on the configured port. But terminal WebSocket servers on ports 14800/14801 are separate processes that survive. If A3 dynamically selects a port, `ao stop` won't know the actual port used.

**Why coupled:** If the dashboard port can shift dynamically (A3), then `ao stop` (A4) can't rely on the static config port — it needs the actual resolved state. Both fixes share a run state persistence mechanism.

**Mechanism:**

1. **Run state file** — On `ao start`, after resolving the actual dashboard port and terminal ports, write a run state file. The filename is derived entirely from hashes to prevent path injection — project keys are unconstrained (`z.record()` in config schema), so raw names must never be used as path segments:

```typescript
// Filename: sha256(absoluteConfigPath + ":" + projectName), first 16 chars
// Location: ~/.ao/run/<hash>.json
// Example: ~/.ao/run/a1b2c3d4e5f6g7h8.json
import { createHash } from "node:crypto";
function runStateFilename(configPath: string, projectName: string): string {
  const hash = createHash("sha256")
    .update(`${configPath}:${projectName}`)
    .digest("hex")
    .slice(0, 16);
  return `${hash}.json`;
}

// Contents:
{
  "configPath": "/abs/path/to/agent-orchestrator.yaml",
  "projectName": "my-app",
  "dashboardPid": 12345,
  "dashboardPort": 3001,
  "terminalPorts": [14800, 14801],
  "startedAt": "2026-02-28T...",
  "pgid": 12345     // process group ID for group kill
}
```

Write atomically (write to `.tmp`, rename) with mode `0o600`. The `configPath` and `projectName` fields inside the JSON are for human debugging only — the filename is the lookup key.

2. **Port collision detection (R3)** — Before launching dashboard, check if configured port is available using existing `isPortAvailable()`. If taken, scan range (configured + 1 through configured + 10). Use first available. Print actual port. If no port available, fail with clear error.

3. **Dashboard spawn with process group** — Spawn dashboard with `detached: true` and `setsid`-equivalent behavior so the parent PID becomes the process group leader. Store PGID in run state.

4. **Process cleanup (R4)** — On `ao stop`, read the run state file. Before killing:
   - **Verify PID liveness**: check if PID exists (`kill(pid, 0)`)
   - **Verify PID identity**: compare process command/cwd against expected dashboard process (prevents stale-PID-reuse kills)
   - Kill process group via `process.kill(-pgid, 'SIGTERM')` — cleans up dashboard + all terminal WS children
   - Delete run state file after cleanup
   - If run state file is missing (legacy), fall back to current `lsof` behavior on configured port only, with a warning

**Where:**
- `packages/cli/src/lib/web-dir.ts` — port scanning, run state I/O, process group spawn, verified cleanup
- `packages/cli/src/commands/start.ts` — pass resolved port, log actual port

**Scope:** ~45 lines across 2 files.

**Tests:**
- Port 3000 occupied → dashboard starts on 3001, run state records 3001
- `ao stop` with valid run state → kills process group, cleans up run state file
- `ao stop` with stale PID in run state → skips kill, warns, cleans up file
- `ao stop` with missing run state → falls back to lsof with warning

---

### A5: Validate Project Path at Startup

**Problem:** `ao start` loads project config and spawns without verifying the project path still exists on disk (`start.ts:141-256`). If the directory was deleted between sessions, the error surfaces deep in workspace creation — opaque and confusing.

**Mechanism:** Early in `ao start`, after resolving the project config, check that `project.path` exists and is a directory. Fail immediately with: `"Project path does not exist: /path/to/app — was it moved or deleted?"`.

**Where:** `packages/cli/src/commands/start.ts`, after project resolution (~line 143):

```typescript
if (!existsSync(project.path)) {
  throw new Error(`Project path does not exist: ${project.path} — was it moved or deleted?`);
}
```

**Scope:** ~4 lines in one file.

**Tests:** Add test: config with nonexistent path → `ao start` fails with clear error message before any spawn attempt.

---

### A6: Expand `~` in `AO_CONFIG_PATH` and Fail Loudly

**Problem:** `config.ts` in `findConfigFile()` (line 295-302) reads `AO_CONFIG_PATH` and calls `resolve()` on it. But `resolve("~/foo")` doesn't expand `~` — it joins with CWD, producing `$CWD/~/foo`. The config load silently fails and falls back to default search. Additionally, if the user explicitly sets `AO_CONFIG_PATH` to a nonexistent file (even after tilde expansion), the silent fallback to default config search is confusing — the user expects their specified path to be used.

**Mechanism:** Two fixes inside `findConfigFile()`:

1. **Tilde expansion** — Apply the existing `expandHome()` utility (`packages/core/src/paths.ts:162-167`) to the `AO_CONFIG_PATH` value before calling `resolve()`.

2. **Fail loudly on invalid path** — If `AO_CONFIG_PATH` is set but the expanded path doesn't exist, throw an error instead of silently falling back. The user explicitly told us where the config is; if it's not there, that's an error.

**Where:** `packages/core/src/config.ts`, inside `findConfigFile()` (~line 295-302):

```typescript
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const expanded = resolve(expandHome(process.env["AO_CONFIG_PATH"]));
    if (!existsSync(expanded)) {
      throw new Error(
        `AO_CONFIG_PATH points to nonexistent file: ${expanded}` +
        (expanded !== process.env["AO_CONFIG_PATH"] ? ` (expanded from: ${process.env["AO_CONFIG_PATH"]})` : ""),
      );
    }
    return expanded;
  }
  // 2-4. Continue with existing search cascade...
```

**Scope:** ~8 lines in `findConfigFile()`.

**Tests:** Add tests in `config.test.ts`:
- `AO_CONFIG_PATH=~/foo.yaml` with `~/foo.yaml` existing → found and returned
- `AO_CONFIG_PATH=~/nonexistent.yaml` → throws error mentioning the expanded path
- `AO_CONFIG_PATH=/absolute/path.yaml` existing → works as before
- `AO_CONFIG_PATH` not set → falls through to normal search cascade (no change)

---

### A7: Clear Session Status When Agent Exits Cleanly

**Problem:** When a Claude Code agent process exits (finishes its work), the tmux session stays alive (tmux doesn't auto-close). `session-manager.ts:551-570` detects `activity = "exited"` because the process isn't running, but the tmux session still exists. Status page shows the session with "exited" activity but a non-terminal status — ambiguous. Lifecycle manager keeps polling it because `lifecycle-manager.ts:536` and `:560` only skip sessions with `status === "merged" || status === "killed"`, not `"done"`.

**Session status enum reference** (`types.ts:26-42`): statuses include `"spawning"`, `"working"`, `"pr_open"`, `"ci_failed"`, `"review_pending"`, `"changes_requested"`, `"approved"`, `"mergeable"`, `"merged"`, `"cleanup"`, `"needs_input"`, `"stuck"`, `"errored"`, `"killed"`, `"done"`, `"terminated"`. There is no `"running"` status.

**Mechanism:**

1. **Transition to `"done"` status** — In `session-manager.ts` status refresh logic: when `activity === "exited"` AND the session status is NOT already terminal, transition to `status: "done"`. Use the shared predicate:

```typescript
// In ensureHandleAndEnrich() or equivalent status refresh:
if (activity === "exited" && !TERMINAL_STATUSES.has(session.status)) {
  session.status = "done";
}
```

2. **Update lifecycle-manager.ts to use TERMINAL_STATUSES** — Replace hardcoded `"merged"/"killed"` checks with the shared `TERMINAL_STATUSES` set at both sites:

```typescript
// lifecycle-manager.ts:536 — session filtering
const sessionsToCheck = sessions.filter((s) => {
  if (!TERMINAL_STATUSES.has(s.status)) return true;
  const tracked = states.get(s.id);
  return tracked !== undefined && tracked !== s.status;
});

// lifecycle-manager.ts:560 — all-complete check
const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));
```

3. **Update `start.ts:203` terminal check** — Change from `existing.status !== "killed"` to `!isTerminalSession(existing)` (or `!TERMINAL_STATUSES.has(existing.status)`). This ensures `"done"`, `"errored"`, `"terminated"`, etc. all correctly allow restart instead of blocking it.

4. **Clean up orphaned tmux session** — After transitioning to `"done"`, destroy the tmux session via `plugins.runtime.destroy(session.runtimeHandle)` since it no longer serves a purpose.

**Where:**
- `packages/core/src/session-manager.ts:551-570` — add state transition using `TERMINAL_STATUSES`
- `packages/core/src/lifecycle-manager.ts:536,560` — replace hardcoded status checks with `TERMINAL_STATUSES`
- `packages/cli/src/commands/start.ts:203` — replace `!== "killed"` with `!TERMINAL_STATUSES.has()`

**Scope:** ~12 lines across 3 files.

**Tests:**
- `session-manager.test.ts`: activity "exited" + status "working" → transitions to "done"
- `session-manager.test.ts`: activity "exited" + status "done" (already terminal) → no change
- `session-manager.test.ts`: `isTerminalSession()` returns true for "done" (already covered by existing tests, verify)
- `lifecycle-manager.test.ts` or integration: "done" sessions excluded from polling
- `start.ts` test: session with status "done" → allows restart (doesn't block)

---

## Fit Check

| Req | Requirement | Part | Covered? |
|-----|-------------|------|----------|
| R0 | Agent sessions start unattended — no permission prompts | A0 | ✅ Zod default + `getAgentConfig()` runtime fallback in both worker/orchestrator paths |
| R1 | `ao project add` rejects non-git directories | A1 | ✅ `git rev-parse --is-inside-work-tree`, assert stdout `"true"`, directory check |
| R2 | Default branch auto-detected from repo | A2 | ✅ Detect at registration, persist in config, warn on legacy Zod-defaulted configs |
| R3 | Dashboard port collision → find available port or fail clearly | A3+A4 | ✅ Port scan + run state persistence with actual resolved port |
| R4 | `ao stop` cleans up ALL processes including terminal WS | A3+A4 | ✅ Track PGID in run state, verified process-group kill, lsof fallback for legacy |
| R5 | `ao start` validates project path exists before spawning | A5 | ✅ `existsSync` check after project resolution |
| R6 | `AO_CONFIG_PATH` expands `~` and fails loudly if invalid | A6 | ✅ `expandHome()` in `findConfigFile()` + throw on nonexistent path |
| R7 | Agent exit → session marked "done", not ambiguous | A7 | ✅ Non-terminal→"done" transition + `TERMINAL_STATUSES` in lifecycle-manager + start.ts |

All 8 requirements covered. All mechanisms verified against actual codebase types, function names, and status enums.

---

## Effort Estimate

| Part | Files Touched | Lines Changed | Complexity |
|------|--------------|---------------|------------|
| A0 | 2 (config.ts, session-manager.ts) | ~5 | Trivial |
| A1 | 1 (project-add.ts) | ~15 | Small |
| A2 | 2-3 (project-add.ts, git-utils.ts, start.ts) | ~35 | Small |
| A3+A4 | 2 (web-dir.ts, start.ts) | ~45 | Medium |
| A5 | 1 (start.ts) | ~4 | Trivial |
| A6 | 1 (config.ts) | ~8 | Trivial |
| A7 | 3 (session-manager.ts, lifecycle-manager.ts, start.ts) | ~12 | Small |
| **Tests** | ~5 test files | ~60 | Small |
| **Total** | **~10 unique files** | **~185 lines** | **Small-Medium** |

A3+A4 is the only medium-complexity piece (run state file I/O + process group management). All other fixes are trivial or small. Can be done in a single slice. No spikes needed.

---

## Open Questions

None. All 8 gaps are concrete, all mechanisms verified against source code types and function names, all review feedback incorporated. Ready to slice.
