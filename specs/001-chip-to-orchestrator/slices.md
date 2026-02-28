---
shaping: true
---

# Chip-to-Orchestrator Pipeline — Slices

## User Story

> As a user chatting with Chip on Telegram from my phone, I want to describe an app idea — whether it's a rough concept like "todo app with auth" or a fully fleshed-out spec — and have Chip create the repo, kick off the orchestrator, and have working code building itself on my Mac Mini by the time I put my phone down, with Chip pinging me on Telegram only when something actually needs my attention.

---

## Slice Overview

| Slice | Title | Parts | Demo |
|-------|-------|-------|------|
| **V1** | Chip can start a build from a rough idea | A1, A2 (partial), A3 (partial) | Run two CLI commands → orchestrator launches, explores repo, starts building |
| **V2** | Full spec → parallel workers | A2 (complete), A3 (complete), A5 | Put tasks.md in project → `ao start` → issues created, parallel Codex workers spawned |
| **V3** | Chip stays informed + anti-churn backstop | A4, A6 | Orchestrator sends webhook events to Chip. Stuck session → Chip gets escalation |

---

## V1: Chip Can Start a Build from a Rough Idea

**What this delivers:** The minimum end-to-end pipeline. Chip registers a project and starts it with an inline prompt. An orchestrator agent launches with the discover-first mindset, explores the repo, and starts building.

**Parts included:**

| Part | What | New code? |
|------|------|-----------|
| A1 | `ao project add` CLI command | Yes — new command |
| A2 (partial) | `ao start --prompt "..."` — launch orchestrator with inline prompt | Yes — new flag on existing command |
| A3 (partial) | Rough-idea mode prompt — discover-first, weight-matched | Yes — prompt template |

**What Chip does (after V1):**

```bash
# 1. Create repo (Chip already knows how)
gh repo create carmandale/my-new-app --public --clone
cd ~/my-new-app && git push

# 2. Register with orchestrator (NEW)
ao project add my-new-app \
  --repo carmandale/my-new-app \
  --path ~/my-new-app \
  --branch main \
  --session-prefix app \
  --agent codex \
  --agent-permissions skip

# 3. Start the build (NEW)
ao start my-new-app --prompt "Build a todo app with auth and a nice dashboard"
```

**What the orchestrator does:**

1. Receives the prompt via A3's rough-idea template
2. Explores the repo (README, existing files, tools, CI)
3. Starts building — scaffolds, codes, commits, iterates
4. Can spawn workers later if the work becomes clear enough
5. Reports completion/errors via existing notification system

**Demo criteria:**
- `ao project add` writes valid YAML to `agent-orchestrator.yaml`
- `ao start --prompt` launches an orchestrator session
- Orchestrator agent receives the discover-first prompt
- Agent explores the repo and makes at least one commit

**What V1 does NOT include:**
- No spec detection (use `--prompt` only)
- No webhook to Chip (uses existing desktop notifier)
- No anti-churn guardrails (prompt is the only defense)

---

## V2: Full Spec → Parallel Workers

**What this delivers:** When Chip has fleshed out an idea into full spec artifacts (spec.md, plan.md, tasks.md), the orchestrator auto-detects them, creates GitHub issues, and spawns parallel Codex workers.

**Depends on:** V1 (project registration + orchestrator launch)

**Parts included:**

| Part | What | New code? |
|------|------|-----------|
| A2 (complete) | `ao start` auto-detects `specs/` in project dir | Yes — spec detection logic |
| A3 (complete) | Full-spec mode prompt — decompose tasks, spawn workers | Yes — second prompt template |
| A5 | Adaptive kickoff — detect spec maturity, select mode | Yes — mode selection logic |

**What Chip does (after V2):**

```bash
# Chip has already: created repo, pushed scaffold, written spec artifacts
# specs/001-my-new-app/spec.md, plan.md, tasks.md exist in the repo

# Register (same as V1)
ao project add my-new-app --repo carmandale/my-new-app --path ~/my-new-app

# Start — no --prompt needed, specs auto-detected
ao start my-new-app
```

**How mode selection works (A5):**

```
ao start my-new-app
  │
  ├─ specs/*/tasks.md found? → Full-spec mode (A3 full-spec prompt)
  │    → Create issues from tasks, spawn parallel Codex workers
  │
  ├─ specs/*/spec.md found but no tasks.md? → Give orchestrator context, let it choose
  │    → Agent has spec context, decides whether to decompose or iterate
  │
  └─ No specs found + no --prompt? → Error: "No spec found. Use --prompt for rough ideas."
```

**Demo criteria:**
- `ao start` with no `--prompt` flag auto-detects `specs/001-*/tasks.md`
- Orchestrator receives the full-spec prompt with spec contents injected
- Orchestrator creates GitHub issues from tasks
- Orchestrator spawns parallel Codex workers per issue
- Workers create PRs

**What V2 does NOT include:**
- No webhook to Chip (still uses desktop notifier)
- No anti-churn guardrails

---

## V3: Chip Stays Informed + Anti-Churn Backstop

**What this delivers:** Orchestrator events flow to Chip via webhook so Chip can relay to Telegram. Output-based stuck detection catches sessions that aren't shipping code and escalates to Chip instead of retrying.

**Depends on:** V1 (basic pipeline), V2 (parallel workers to monitor)

**Parts included:**

| Part | What | New code? |
|------|------|-----------|
| A4 | Webhook notifier config for Chip | No new code — config + docs |
| A6 | Output-based stuck detection + escalation | Yes — git activity tracking in lifecycle manager |

**Webhook config (A4):**

```yaml
# In agent-orchestrator.yaml
notifiers:
  chip:
    plugin: webhook
    url: http://localhost:9876/ao-events

notificationRouting:
  urgent: [chip]    # stuck, needs input, errored
  action: [chip]    # PR ready to merge
  warning: [chip]   # auto-fix failed
  info: [chip]      # summary, all done
```

Chip runs a lightweight HTTP listener on the Mac Mini. The webhook notifier plugin already exists — this is just config.

**Stuck detection (A6):**

Two layers, as detailed in shaping doc:

- **Layer 1 (A3, already shipped in V1/V2):** The prompt prevents the root cause — orchestrator discovers before prescribing
- **Layer 2 (A6, this slice):** Detect symptoms when root cause slips through:
  - Track git activity (commits, pushes) per session
  - Session alive 10+ min with zero git activity → stuck
  - Restart count per issue → after 3, escalate instead of retry
  - Escalation goes to Chip via webhook with context

**Demo criteria:**
- Orchestrator events appear at Chip's webhook endpoint
- Start a session that makes no commits for 10+ min → stuck notification sent to Chip
- Session that restarts 3x on same issue → escalation sent instead of 4th retry
- Chip receives actionable context: session ID, issue, last error, time stuck

---

## Slice Dependencies

```
V1: Rough idea → build
 │
 ▼
V2: Full spec → parallel workers
 │
 ▼
V3: Webhook + anti-churn
```

V1 is the foundation. V2 adds the structured path. V3 adds observability and safety.

---

## What Already Exists (no slice needed)

- Webhook notifier plugin — exists, just needs config (A4)
- Session lifecycle management — exists
- Codex agent plugin — exists
- PR/CI/review tracking — exists
- GitHub issues integration — exists (tracker-github)
- `ao spawn`, `ao status`, `ao send`, `ao kill` — exist
- Desktop notifier — exists (V1/V2 use this before V3 wires webhook)
