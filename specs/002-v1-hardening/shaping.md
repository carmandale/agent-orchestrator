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
| R6 | `AO_CONFIG_PATH` must expand `~` to home directory | Must-have |
| R7 | When agent process exits but tmux session stays, status must reflect "completed" not ambiguous "exited while running" | Must-have |

---

## Shape A: Systematic Fixes

Each part maps 1:1 to a requirement. All fixes are independent — no ordering dependencies between them.

### A0: Default `permissions: skip` for Unattended Sessions

**Problem:** `AgentSpecificConfig.permissions` is optional with no default (`packages/core/src/types.ts:931`). When not set, Claude Code launches in interactive permission mode — prompts for approval, blocks forever in unattended sessions.

**Mechanism:** In `spawnOrchestrator()` and `spawnWorker()` (or the agent launch path), if `permissions` is not explicitly set in config, default to `"skip"`. This ensures unattended sessions never block on permission prompts.

**Where:** `packages/core/src/config.ts` — add Zod default to `permissions` field in `AgentSpecificConfig`:

```typescript
permissions: z.enum(["skip", "default"]).default("skip"),
```

**Scope:** One line in the Zod schema. All downstream consumers already handle the `"skip"` value correctly.

---

### A1: Validate Git Repo in `ao project add`

**Problem:** `project-add.ts:77-80` validates path exists (`existsSync`) but not that it's a git repository. Non-git paths are accepted, then fail later during workspace creation with opaque errors.

**Mechanism:** After the `existsSync` check, verify `.git` exists at the path (or run `git rev-parse --git-dir` in the directory). Fail early with a clear message: `"Path exists but is not a git repository: /path/to/dir"`.

**Where:** `packages/cli/src/commands/project-add.ts`, after line 80. Add:

```typescript
const gitDir = path.join(expandedPath, ".git");
if (!existsSync(gitDir)) {
  throw new Error(`Path is not a git repository (no .git directory): ${expandedPath}`);
}
```

**Scope:** ~4 lines in one file.

---

### A2: Auto-Detect Default Branch from Repo

**Problem:** `config.ts:66` hardcodes `defaultBranch: z.string().default("main")`. Repos using `"master"` get the wrong default. Orchestrator creates worktrees on wrong branch.

**Mechanism:** When loading project config, if `defaultBranch` is not explicitly set, detect it from the repo:

1. Run `git -C <projectPath> symbolic-ref refs/remotes/origin/HEAD` → parse branch name
2. Fallback: `git -C <projectPath> rev-parse --abbrev-ref HEAD` → use current branch
3. Final fallback: `"main"` (existing behavior)

**Where:** Two changes:
- `packages/core/src/config.ts` — remove the `.default("main")` from the Zod schema, make it `z.string().optional()`
- `packages/cli/src/commands/start.ts` or a new utility — detect branch at startup when `defaultBranch` is undefined, inject into resolved config

**Scope:** ~15 lines of git detection logic + schema tweak.

---

### A3: Dashboard Port Collision Detection

**Problem:** Dashboard launches on `config.port ?? 3000` without checking availability (`start.ts:145`). If port is taken, Next.js fails silently — no dashboard, no error.

**Mechanism:** Before launching the dashboard, check if the port is available using the existing `isPortAvailable()` utility (`packages/cli/src/lib/web-dir.ts:23-34`). If taken:

1. Try next N ports (3001, 3002, ...) up to a limit
2. Use the first available port
3. Print the actual port to stdout so Chip/user knows where the dashboard is
4. If no port available in range, fail with clear error

**Where:** `packages/cli/src/commands/start.ts`, before `startDashboard()` call (~line 185). Use existing `isPortAvailable()`.

**Scope:** ~15 lines in start.ts.

---

### A4: Clean Up Terminal WS Processes on `ao stop`

**Problem:** `ao stop` kills the orchestrator session and dashboard process (`start.ts:299-337`). But terminal WebSocket servers spawned by the dashboard on ports 14800/14801 are separate processes that survive. Next `ao start` can't bind those ports.

**Mechanism:** In `stopDashboard()` (`web-dir.ts`), after killing the dashboard process, also find and kill processes on the terminal WS port range:

1. Track the terminal ports used (stored in dashboard env or session metadata)
2. On stop: `lsof -ti :<port>` for each terminal port pair, kill those PIDs
3. Alternative: kill the entire process group spawned by the dashboard

**Where:** `packages/cli/src/lib/web-dir.ts` — extend `stopDashboard()` to accept terminal port range and clean those up too. Update `start.ts` stop handler to pass the ports.

**Scope:** ~20 lines across two files.

---

### A5: Validate Project Path at Startup

**Problem:** `ao start` loads project config and spawns without verifying the project path still exists on disk (`start.ts:141-256`). If the directory was deleted between sessions, the error surfaces deep in workspace creation — opaque and confusing.

**Mechanism:** Early in `ao start`, after resolving the project config, check that `project.path` exists and is a directory. Fail immediately with: `"Project path does not exist: /path/to/app — was it moved or deleted?"`.

**Where:** `packages/cli/src/commands/start.ts`, after project resolution (~line 143). Add:

```typescript
if (!existsSync(project.path)) {
  throw new Error(`Project path does not exist: ${project.path} — was it moved or deleted?`);
}
```

**Scope:** ~4 lines in one file.

---

### A6: Expand `~` in `AO_CONFIG_PATH`

**Problem:** `config.ts:297-302` reads `AO_CONFIG_PATH` and calls `resolve()` on it. But `resolve("~/foo")` doesn't expand `~` — it joins with CWD, producing `$CWD/~/foo`. The config load silently fails and falls back to default search.

**Mechanism:** Apply the existing `expandHome()` utility (`packages/core/src/paths.ts:162-167`) to the `AO_CONFIG_PATH` value before calling `resolve()`.

**Where:** `packages/core/src/config.ts`, line ~298:

```typescript
const envPath = process.env["AO_CONFIG_PATH"];
const configPath = envPath ? resolve(expandHome(envPath)) : findConfigPath();
```

**Scope:** 1 line change (wrap with `expandHome()`).

---

### A7: Clear Session Status When Agent Exits Cleanly

**Problem:** When a Claude Code agent process exits (finishes its work), the tmux session stays alive (tmux doesn't auto-close). `session-manager.ts:551-570` detects `activity = "exited"` because the process isn't running, but the tmux session still exists. Status page shows the session as alive but with "exited" activity — ambiguous. Lifecycle manager keeps polling a dead session.

**Mechanism:** When activity detection reports "exited" for an agent process:

1. Mark the session status as `"done"` (not just activity as "exited")
2. Optionally kill the orphaned tmux session (it served its purpose)
3. Stop polling the session — it's terminal

The key change is in `session-manager.ts` status refresh logic: when `activity === "exited"` AND the session was previously `"running"`, transition to `status: "done"` instead of leaving it in a limbo state.

**Where:** `packages/core/src/session-manager.ts`, in the status refresh method (~line 551-570). Add state transition logic:

```typescript
if (activity === "exited" && session.status === "running") {
  session.status = "done";
  // Optionally: await plugins.runtime.destroy(session.runtimeHandle);
}
```

**Scope:** ~5 lines in session-manager.ts + optional tmux cleanup.

---

## Fit Check

| Req | Requirement | Part | Covered? |
|-----|-------------|------|----------|
| R0 | Agent sessions start unattended — no permission prompts | A0 | ✅ Default `permissions: skip` in Zod schema |
| R1 | `ao project add` rejects non-git directories | A1 | ✅ Check `.git` at path, fail early |
| R2 | Default branch auto-detected from repo | A2 | ✅ `git symbolic-ref` → `git rev-parse` → `"main"` fallback |
| R3 | Dashboard port collision → find available port or fail clearly | A3 | ✅ Use existing `isPortAvailable()`, scan range |
| R4 | `ao stop` cleans up ALL processes including terminal WS | A4 | ✅ Extend `stopDashboard()` to kill terminal ports |
| R5 | `ao start` validates project path exists before spawning | A5 | ✅ `existsSync` check after project resolution |
| R6 | `AO_CONFIG_PATH` expands `~` to home directory | A6 | ✅ Apply `expandHome()` before `resolve()` |
| R7 | Agent exit → session marked "done", not ambiguous | A7 | ✅ State transition in session-manager status refresh |

All 8 requirements covered. All mechanisms use existing utilities where possible. No new abstractions needed.

---

## Effort Estimate

| Part | Files Touched | Lines Changed | Complexity |
|------|--------------|---------------|------------|
| A0 | 1 (config.ts) | ~1 | Trivial |
| A1 | 1 (project-add.ts) | ~4 | Trivial |
| A2 | 2 (config.ts, start.ts or utility) | ~15 | Small |
| A3 | 1 (start.ts) | ~15 | Small |
| A4 | 2 (web-dir.ts, start.ts) | ~20 | Small |
| A5 | 1 (start.ts) | ~4 | Trivial |
| A6 | 1 (config.ts) | ~1 | Trivial |
| A7 | 1 (session-manager.ts) | ~5 | Small |
| **Total** | **~6 unique files** | **~65 lines** | **Small** |

All fixes are independent. Can be done in a single slice. No spikes needed — all mechanisms are known and verified against the current codebase.

---

## Open Questions

None. All 8 gaps are concrete, all mechanisms verified against source code. Ready to slice.
