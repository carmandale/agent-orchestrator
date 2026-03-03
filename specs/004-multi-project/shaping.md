---
shaping: true
bead: agent-orchestrator-8
---

# Multi-Project Dispatch — Shaping

## Source

> What I need for AO: Based on yesterday's notes — AO is configured to point at the agent-orchestrator repo only. When I tried to run apple-notes-export through it, the worktree was wrong. I need:
>
> 1. AO config updated for multi-project dispatch — so I can point it at any repo, not just agent-orchestrator

Context: Chip is running openclaw on a Mac mini with AO installed. His config has a single project entry (`ao`). When he tried to run apple-notes-export through AO, the worktree was created from the agent-orchestrator repo path, not apple-notes-export's path.

---

## Problem

AO's core architecture already supports multiple projects — `projects:` is a map, commands take `[project]` args, worktrees/sessions are namespaced per project. But the **onboarding UX** makes it hard to actually use multiple projects:

1. Chip's config has only one project entry. Adding more requires knowing `ao project add` exists and passing the right flags.
2. The `repo` field (owner/repo format) is **required** — blocks local-only repos that have no GitHub remote.
3. No "just point at this directory" quick-add flow — current UX requires `--repo` and `--path` flags even when git metadata could infer both.
4. Error messages when running `ao start` on an unconfigured repo don't guide toward `ao project add`.

## Outcome

Chip can do: `cd ~/dev/apple-notes-export && ao project add apple-notes-export` (one command, infers repo/path/branch from git) → `ao start apple-notes-export` and everything works — correct worktree, correct sessions, no conflicts with agent-orchestrator.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Chip can add any local git repo as an AO project in one command | Core goal |
| R1 | Local-only repos (no GitHub remote) work without requiring a repo field | Must-have |
| R2 | `ao project add <name>` infers repo, path, and branch from git when run inside the repo | Must-have |
| R3 | Multiple projects can run simultaneously (different ports, no worktree/session collisions) | Must-have |
| R4 | Error messages guide users to `ao project add` when they reference unconfigured projects | Nice-to-have |
| R5 | Existing single-project configs continue to work unchanged | Must-have |

---

## CURRENT: How It Works Today

| Part | Mechanism |
|------|-----------|
| **C1** | Config `projects:` is `Record<string, ProjectConfig>` — already a multi-project map |
| **C2** | `ao start [project]` dispatches via `resolveProject()` — uses arg, or defaults to single project |
| **C3** | Worktrees namespaced: `~/.worktrees/{projectId}/{sessionId}` |
| **C4** | Sessions namespaced: `~/.agent-orchestrator/{hash}-{projectId}/sessions/` |
| **C5** | `ao project add <name> --repo owner/repo --path ~/path` adds to YAML |
| **C6** | `repo` field is required (`z.string()`, no default) + validated as `owner/repo` format |
| **C7** | Port auto-detection: dashboard scans port range, terminal WS scans 14800+ |

**Fit: CURRENT × R**

| Req | Requirement | Status | CURRENT |
|-----|-------------|--------|---------|
| R0 | One-command add | Core goal | ❌ |
| R1 | Local-only repos | Must-have | ❌ |
| R2 | Infer from git | Must-have | ❌ |
| R3 | Simultaneous projects | Must-have | ✅ |
| R4 | Error guidance | Nice-to-have | ❌ |
| R5 | Backwards compat | Must-have | ✅ |

**Notes:**
- CURRENT fails R0: requires `--repo` and `--path` flags even inside the repo
- CURRENT fails R1: `repo` is required in schema + validated as owner/repo format
- CURRENT fails R2: no git inference — all fields must be explicit
- CURRENT passes R3: architecture already supports it (namespaced worktrees/sessions/ports)

---

## A: Git-Inferred Project Add + Optional Repo

Make `ao project add` smarter and `repo` optional.

| Part | Mechanism |
|------|-----------|
| **A1** | **Make `repo` optional in schema**: Change `ProjectConfigSchema.repo` from `z.string()` to `z.string().optional()`. Change `ProjectConfig.repo` to `string \| undefined`. |
| **A2** | **Auto-infer in `ao project add`**: When `--path` not provided, default to CWD. When `--repo` not provided, run `git remote get-url origin` and parse owner/repo. When `--branch` not provided, detect default branch (already done). |
| **A3** | **Minimal add flow**: `cd ~/dev/apple-notes-export && ao project add apple-notes-export` — infers path from CWD, repo from git remote, branch from default. Only name is required. |
| **A4** | **Guard SCM/tracker inference**: Today, SCM is inferred from repo presence. If repo is missing, skip SCM/tracker inference (no PR tracking for local-only repos). |
| **A5** | **Error guidance**: When `resolveProject()` fails because project not found, suggest `ao project add <name> --path <path>` in error message. |

**Fit: A × R**

| Req | Requirement | Status | A |
|-----|-------------|--------|---|
| R0 | One-command add | Core goal | ✅ |
| R1 | Local-only repos | Must-have | ✅ |
| R2 | Infer from git | Must-have | ✅ |
| R3 | Simultaneous projects | Must-have | ✅ |
| R4 | Error guidance | Nice-to-have | ✅ |
| R5 | Backwards compat | Must-have | ✅ |

---

## Selected Shape: A

Shape A is the minimal effective change. The architecture already works — this is purely a UX/config fix.

## Implementation Plan

### 1. Make `repo` optional in config schema

**Files:** `packages/core/src/config.ts`, `packages/core/src/types.ts`

- `ProjectConfigSchema`: change `repo: z.string()` → `repo: z.string().optional()`
- `ProjectConfig` interface: change `repo: string` → `repo?: string`
- `applyProjectDefaults()`: skip SCM/tracker inference when `repo` is undefined
- `validateProjectUniqueness()`: no change needed (uses path basename)

### 2. Auto-infer in `ao project add`

**File:** `packages/cli/src/commands/project-add.ts`

- Make `--repo` optional (remove `requiredOption`, use `option`)
- Make `--path` optional (default to `process.cwd()`)
- When `--repo` not provided: run `git remote get-url origin` in the project path, parse owner/repo from URL. If no remote, leave repo undefined.
- Remove strict `REPO_FORMAT_RE` validation when repo was auto-inferred from git

### 3. Error guidance in resolveProject

**File:** `packages/cli/src/commands/start.ts`

- When project arg not found, include `ao project add` in error message
- Example: `Project "apple-notes-export" not found. Run: ao project add apple-notes-export --path ~/dev/apple-notes-export`

### 4. Guard downstream consumers of `repo`

**Files:** Various plugins and core files that use `project.repo`

- `tracker-github`: skip if `repo` is undefined
- `scm-github`: skip if `repo` is undefined
- `generateOrchestratorPrompt`: handle optional repo
- `branchName()` in trackers: handle missing repo gracefully

### 5. Tests

- Unit test: `ao project add` with CWD inference
- Unit test: config validation with optional repo
- Unit test: resolveProject error message includes guidance

### 6. Chip's config update

After code ships, Chip adds projects on mini:
```bash
cd ~/dev/apple-notes-export
ao project add apple-notes-export
# Done — repo, path, branch all inferred from git
```
