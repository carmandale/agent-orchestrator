---
shaping: true
---

# Chip-to-Orchestrator Pipeline — Shaping

## Source

> The goal of this app/tool is for openclaw/chip running on the mac mini, to be able to launch an orchestrator and for that orchestrator to launch codex sessions to run projects.
>
> This is the userflow:
>
> I am out and have an idea for a new app. I use telegram and talk to Chip (openclaw running on mac mini) and once we have fleshed it out, chip creates a github repo and plan and launches orchestrator agent to build it.

> Chip can run shell commands on the Mac Mini.
> Plan format is standard specs: spec.md, plan.md, tasks.md.
> Notifications go through Chip — orchestrator reports to Chip, Chip relays to user on Telegram.
> PR review: mobile for awareness, laptop for finalization.
> Projects: both throwaway prototypes and long-lived.

---

## The Pipeline

```
User (mobile, Telegram)
  ↕ chat
Chip (OpenClaw, Mac Mini)
  │
  ├─ 1. Flesh out idea via conversation
  ├─ 2. gh repo create + push scaffold
  ├─ 3. Create specs/<id>/spec.md, plan.md, tasks.md
  ├─ 4. ao project add <name> --repo org/app --path ~/app
  ├─ 5. ao start <name> --from-spec specs/001-*/
  │
  ▼
Orchestrator Agent (Mac Mini)
  │
  ├─ 6. Read spec artifacts
  ├─ 7. Create GitHub issues from tasks.md
  ├─ 8. ao spawn <project> --issue <n> (per issue, Codex workers)
  ├─ 9. Lifecycle: PR → CI → Review → Merge
  │
  ├─ Events → webhook → Chip → Telegram → User
  │
  ▼
Done (or User redirects via Chip)
```

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Chip can go from spec artifacts → running build agents via CLI | Core goal |
| R1 | Chip can register a new project with the orchestrator dynamically (no manual YAML editing) | Must-have |
| R2 | Orchestrator agent can read `specs/<id>/tasks.md` and decompose into GitHub issues | Must-have |
| R3 | Orchestrator spawns parallel Codex workers per issue | Must-have |
| R4 | Orchestrator events reach Chip via webhook for relay to Telegram | Must-have |
| R5 | Pipeline runs unattended on Mac Mini after Chip kicks it off | Must-have |
| R6 | Works for both greenfield prototypes and additions to existing repos | Nice-to-have |
| R7 | User can redirect/intervene via Chip mid-build (e.g., "stop that, change approach") | Nice-to-have |
| 🟡 R8 | Agents produce working code, not churn — the failure mode to prevent is "nothing ships," not "agent does the wrong thing" | Must-have |
| 🟡 R9 | Works with both rough ideas ("todo app with auth") and full specs (spec.md + plan.md + tasks.md) — rough ideas must not be blocked at the gate | Must-have |

---

## Boundary: What's Ours vs. Chip's

| Responsibility | Owner |
|---------------|-------|
| Telegram ↔ user conversation | Chip (OpenClaw) |
| Idea → spec artifacts (spec.md, plan.md, tasks.md) | Chip |
| GitHub repo creation (`gh repo create`) | Chip |
| Initial scaffold (README, CI, package.json) | Chip |
| Receiving webhook events and relaying to Telegram | Chip |
| User intervention commands → `ao` CLI calls | Chip |
| **Registering a project dynamically** | **agent-orchestrator (new)** |
| **Reading spec → creating issues → spawning agents** | **agent-orchestrator (new)** |
| **Webhook notifier to localhost callback** | **agent-orchestrator (exists: webhook notifier)** |
| **Session lifecycle, PR/CI/review management** | **agent-orchestrator (exists)** |

---

## Shape A: CLI-First Pipeline

| Part | Mechanism |
|------|-----------|
| **A1** | **`ao project add`** — CLI command that appends a project to `agent-orchestrator.yaml`. Takes `--repo`, `--path`, `--branch`, `--session-prefix`. Validates repo exists, path exists. Writes YAML. |
| **A2** | **`ao start <project> --from-spec <path>`** — Starts orchestrator agent with spec context. Writes spec content into the orchestrator's system prompt (or a referenced file). Orchestrator agent launches with instructions to decompose and build. |
| 🟡 **A3** | **Orchestrator system prompt: discover-first, weight-matched.** Prompt templates (full-spec mode + rough-idea mode) that instruct the orchestrator to: explore the repo before prescribing, match solution weight to problem weight, think when stuck instead of retrying, ship code not infrastructure, escalate don't loop. The prompt is the primary defense against the harness anti-pattern. |
| **A4** | **Webhook notifier config for Chip** — Chip runs a lightweight HTTP listener on localhost. Orchestrator's webhook notifier posts events to `http://localhost:<port>/ao-events`. Already supported by existing webhook notifier plugin — just needs config. |
| 🟡 **A5** | **Adaptive kickoff — match agent strategy to spec maturity.** When full `tasks.md` exists: orchestrator creates issues and spawns parallel workers. When only rough context exists: orchestrator works as a single iterative agent that builds, commits, and progresses. Either way, the measure of success is commits pushed, not pipeline steps completed. No Zod gates, no validation that blocks work from starting. |
| 🟡 **A6** | **Anti-churn guardrails: measure output, not compliance.** Lifecycle tracks commits/PRs per session. If a session has been alive 10+ min with zero git activity, that's the signal — not "failed to parse tasks.md." Stuck detection nudges the agent or escalates to Chip, rather than killing and respawning into the same wall. |

### Parts Detail

**A1: `ao project add`**

```bash
# What Chip calls:
ao project add my-new-app \
  --repo carmandale/my-new-app \
  --path ~/my-new-app \
  --branch main \
  --session-prefix app \
  --agent codex \
  --agent-permissions skip
```

Programmatic equivalent of manually editing `agent-orchestrator.yaml`. Validates inputs, appends to YAML, confirms.

**A2: `ao start <project> --from-spec`**

```bash
# What Chip calls after project is registered:
ao start my-new-app --from-spec specs/001-my-new-app/
```

This:
1. Reads `spec.md`, `plan.md`, `tasks.md` from the spec path
2. Writes them into a temp file as orchestrator context
3. Launches the orchestrator agent with that context as system prompt
4. Orchestrator agent takes over from there

**A3: Orchestrator System Prompt**

The orchestrator system prompt is the most critical piece of the pipeline. The prior failure was an orchestrator that built an elaborate 665-line bash harness instead of thinking. The prompt must produce an agent that **discovers before prescribing** and **matches solution weight to problem weight.**

**Core principles the prompt must encode:**

1. **Discover first.** Before creating issues, spawning workers, or writing any automation: explore the repo. Read the README. Look at existing tools, scripts, CI. Understand what's already there.
2. **Match weight.** A 4-command task gets 4 commands, not a 665-line orchestration harness. The complexity of the solution must never exceed the complexity of the problem.
3. **Think when stuck.** If a worker fails, don't re-run the same thing. Read the error. Ask: "Is this check even valid? Does this field exist? Is there a simpler approach?"
4. **Ship, don't validate.** The goal is commits pushed and PRs merged, not pipeline steps completed. Prefer doing the work over building infrastructure to track the work.
5. **Escalate, don't loop.** If something isn't working after a real attempt, tell Chip what's wrong and what you've tried. Don't retry the same approach.

**Full-spec mode prompt (tasks.md exists):**

```
You are building [project name]. Here is the context:

[spec.md contents]
[plan.md contents]
[tasks.md contents]

BEFORE doing anything else:
- Explore the repo. Read README, look at existing scripts, tools, CI config.
- Understand what already exists that you can use.
- Match your approach to what the project actually needs.

Then:
1. Create a GitHub issue for each task in tasks.md
2. For each issue, run: ao spawn <project> --issue <number>
3. Monitor sessions via: ao status
4. When all sessions complete, report summary

CRITICAL RULES:
- If a worker is stuck, READ the error. Ask: is this check valid? Is there
  a simpler approach? Don't just retry.
- Never build elaborate validation harnesses. If the task is "run 4 commands,"
  spawn a worker that runs 4 commands.
- The measure of success is code shipped (commits, PRs), not steps completed.
- If stuck after a real attempt, report to Chip with context. Don't loop.
```

**Rough-idea mode prompt (no tasks.md):**

```
You are building [project name]. Here is what the user wants:

[prompt or spec.md contents]

BEFORE doing anything else:
- Explore the repo. Read README, look at existing scripts, tools, CI config.
- Understand what already exists that you can use.

Then start building. You are a single iterative agent:
- Scaffold the project if needed
- Write code, commit, push, iterate
- You can create issues and spawn workers later if the work becomes clear enough
- But start by DOING, not by planning

CRITICAL RULES:
- Don't over-engineer. Build the simplest thing that works, then iterate.
- The measure of success is code shipped, not infrastructure built.
- If stuck, report to Chip with context. Don't loop.
```

**The anti-pattern the prompt prevents:**

The prior orchestrator received "increment build and upload apps to TestFlight" and built: 5 GitHub issues, a coordinator-watcher polling comments every 20s, strict schema enforcement, preflight checklists for nonexistent metadata fields, and repo state snapshots that blocked on any change. 665 lines of bash. Zero apps uploaded.

What should have happened: agent explores repo, finds `gj upload`, runs 4 commands per app. Done.

The prompt must make the agent default to **the simple thing** and treat elaborate infrastructure as a last resort, not a first instinct.

**A4: Webhook → Chip**

Config in `agent-orchestrator.yaml`:

```yaml
notifiers:
  chip:
    plugin: webhook
    url: http://localhost:9876/ao-events

notificationRouting:
  urgent: [chip]
  action: [chip]
  warning: [chip]
  info: [chip]
```

Chip runs a listener on port 9876. Already supported — webhook notifier exists.

**A5: Adaptive Kickoff**

Two key insights:
1. **Match strategy to input maturity** — don't force all input through the same pipe.
2. **Match strategy to task complexity** — the prior failure was an orchestrator that built 665 lines of bash for a 4-command task. The kickoff must set the orchestrator's expectations about the weight of the work.

Two modes, selected automatically based on what exists in the project:

**Mode 1: Full spec → parallel workers**

When `specs/<id>/tasks.md` exists in the project directory:
- Orchestrator agent reads the spec artifacts for context
- Creates GitHub issues from the tasks (agent does this — it can interpret intent, handle ambiguity)
- Spawns parallel Codex workers per issue
- This is the "fleshed out idea" path

**Mode 2: Rough context → single iterative agent**

When there's no structured spec (just a README, a description in the prompt, or a rough outline):
- Orchestrator agent works as a single builder — it scaffolds, codes, commits, iterates
- It can choose to create issues and spawn workers later as the shape of the work becomes clearer
- But it starts by building, not by planning
- This is the "rough idea" path — the agent figures it out

**How `ao start` selects mode:**

```bash
# Full spec exists → parallel mode
ao start my-new-app
# ao detects specs/001-my-new-app/tasks.md → tells orchestrator to decompose

# No spec, just a prompt → iterative mode
ao start my-new-app --prompt "Build a todo app with auth and a nice dashboard"
# ao launches orchestrator with the prompt → agent builds iteratively

# Rough spec (spec.md only, no tasks.md) → orchestrator decides
ao start my-new-app
# ao detects spec.md but no tasks.md → gives orchestrator context, lets it choose
```

The orchestrator agent always gets all available context. The system prompt adapts based on what's present, but never *blocks* based on what's missing.

**What the kickoff passes to the orchestrator (both modes):**

The A3 system prompt is assembled by `ao start` with all available context. Critically, the prompt includes the "discover first" and "match weight" principles from A3. The kickoff doesn't just hand off context — it sets the agent's mindset. The difference between the prior failure and the desired behavior is entirely in what the prompt tells the agent to do with the context it receives.

**A6: Anti-Churn Guardrails**

A6 is the backstop. A3 (the prompt) is the primary defense — if the orchestrator discovers before prescribing and matches solution weight to problem weight, most churn never happens. A6 catches what the prompt doesn't.

**Two layers of defense:**

**Layer 1: A3 prevents the root cause (orchestrator builds harnesses instead of thinking)**

The prior failure wasn't "stuck detection was too slow." It was: the orchestrator built 665 lines of bash that checked for nonexistent metadata fields, and no amount of retry/escalation could fix bad instructions. A3's discover-first prompt is the primary fix.

**Layer 2: A6 detects symptoms when the root cause slips through**

Even with good prompting, agents can get stuck. A6 measures output, not compliance:

**What "stuck" actually means:**
- Session alive 10+ min with zero git commits → stuck (not "failed to validate")
- Session has restarted 3+ times on the same issue → escalate to Chip, don't retry
- Session errored → send error context to Chip, let Chip/user decide next step

**What "stuck" does NOT mean:**
- Agent didn't follow the prescribed workflow exactly → that's fine if code shipped
- Agent created issues in a different format than expected → that's fine if they're valid issues
- Agent built things in a different order than planned → that's fine if it works

**Escalation, not kill-restart:**
When stuck is detected:
1. First: nudge the agent ("You seem stuck. Try a different approach or ask for help.")
2. Second: notify Chip with context ("Session app-3 is stuck on auth middleware. No commits in 15 min. Error: [last error]. Want me to kill it or redirect?")
3. Never: kill and respawn into the same wall automatically

**The anti-pattern to prevent:**
```
spawn → fail → respawn → fail → respawn → fail → ... (infinite churn, zero output)
```

**The pattern to enforce:**
```
spawn → work → stuck? → nudge → still stuck? → escalate to human → human decides
```

**Why A6 alone is insufficient:**

Retry caps and output measurement are necessary but not sufficient. If the orchestrator has already built the wrong thing (a validation harness, a coordinator-watcher, an elaborate pass/fail pipeline), detecting "no commits in 10 min" tells you the symptom, not the cause. The agent will get nudged, retry the same broken approach, and escalate. The human then has to debug what the agent built.

A3 prevents the agent from building the wrong thing in the first place. A6 catches the cases where it still happens.

---

## Fit Check

| Req | Requirement | Status | A |
|-----|-------------|--------|---|
| R0 | Chip can go from spec artifacts → running build agents via CLI | Core goal | ✅ |
| R1 | Register new project dynamically | Must-have | ✅ |
| R2 | Orchestrator reads tasks.md → GitHub issues | Must-have | ✅ |
| R3 | Parallel Codex workers per issue | Must-have | ✅ |
| R4 | Events reach Chip via webhook | Must-have | ✅ |
| R5 | Unattended after kickoff | Must-have | ✅ |
| R6 | Works for greenfield and existing repos | Nice-to-have | ✅ |
| R7 | User can intervene mid-build via Chip | Nice-to-have | ❌ |
| 🟡 R8 | Agents produce working code, not churn — failure mode is "nothing ships" | Must-have | ✅ |
| 🟡 R9 | Works with both rough ideas and full specs | Must-have | ✅ |

**Notes:**
- R7 fails because intervention requires Chip to translate user intent into `ao` CLI commands (`ao send`, `ao kill`, `ao spawn`). The orchestrator already supports these commands, but the mechanism for Chip to know the CLI vocabulary and map user intent is Chip's responsibility, not ours. We document the commands; Chip implements the mapping.
- 🟡 R8 passes via A3 + A6: the orchestrator prompt (A3) is the primary defense — it instructs the agent to discover before prescribing, match solution weight to problem weight, and think when stuck. A6 provides the backstop — if code still isn't shipping despite good prompting, detect it and escalate.
- 🟡 R9 passes via A5: adaptive kickoff matches strategy to input maturity. Full tasks.md → parallel workers. Rough idea → single iterative agent. No gates that block rough ideas from starting.

---

## What Needs to Be Built (in agent-orchestrator)

| # | Part | What | Effort |
|---|------|------|--------|
| 1 | A1 | `ao project add` CLI command | Small — YAML read/write + validation |
| 2 | A2 | `ao start` spec detection — auto-detect `specs/` in project dir, adapt system prompt | Small — file detection + prompt assembly |
| 🟡 3 | A3 | Orchestrator system prompt templates — discover-first, weight-matched, two modes (full-spec + rough-idea). Primary defense against harness anti-pattern. | Medium — prompt engineering + testing against real tasks to verify agent behavior |
| 4 | A4 | Documentation: "Chip integration guide" — CLI commands, webhook config, expected flow | Small |
| 🟡 5 | A5 | Adaptive kickoff logic in `ao start` — detect spec maturity, select mode, pass context | Medium — mode detection, prompt assembly, context packaging |
| 🟡 6 | A6 | Output-based stuck detection — track git activity per session, escalate on zero output | Medium — new metric in lifecycle manager, escalation to Chip via webhook |
| 🟡 7 | A6 | Retry cap — after N restarts on same issue, stop and escalate instead of looping | Small — counter in session metadata, check before respawn |

### What Does NOT Need to Be Built

- Webhook notifier — **already exists**
- Session lifecycle management — **already exists**
- Codex agent plugin — **already exists**
- PR/CI/review tracking — **already exists**
- GitHub issues integration — **already exists** (tracker-github)
- `ao spawn`, `ao status`, `ao send`, `ao kill` — **already exist**
- Zod schema for tasks.md — **not needed** (orchestrator agent interprets, not a parser)
- Plan manifest / dependency graph — **not needed** (orchestrator agent manages sequencing)

---

## Resolved Questions

1. **Orchestrator agent: Claude Code or Codex?** → **Claude Code for orchestrator, Codex for workers.** Already supported via `orchestratorAgent: claude-code` + `agent: codex` in config.

2. **Issue creation: Orchestrator agent or `ao` CLI?** → **Orchestrator agent creates issues** (LLM interprets tasks, handles ambiguity). No rigid parser gate. The guardrail is output-based (A6), not input-based.

3. **Spec path: explicit or convention?** → **Convention by default.** `ao start` looks for `specs/` in the project directory. Single spec = auto-detected. `--prompt` flag for rough ideas with no spec.

4. **Deterministic vs. adaptive?** → **Adaptive.** R8's real concern is "nothing ships" not "agent deviated from plan." Guardrails measure output (commits, PRs), not compliance. The orchestrator agent has latitude to interpret and adjust.

## Resolved: Prior Failure Mode Audit

**Evidence:** `GJ-testflight-release/scripts/tf-release-orchestrate` (265 lines) + `tf-coordinator-watch` (400 lines).

**The task:** "Increment build and upload apps to TestFlight." Required 4 steps per app: resolve packages, commit, push, upload via `gj upload`.

**What the orchestrator actually built:**
- 5 separate GitHub issues for a single task
- A coordinator-watcher polling issue comments every 20s for structured status reports
- Strict schema enforcement requiring `Status:`, `Build:`, `Uploaded:` in exact format
- A preflight checklist checking for `marketing_version`, `app_store_metadata` — **things that don't exist in the repos**
- Repo state snapshots before/after that BLOCK if anything changed (defeating the purpose)
- Workers that could only run the prescribed checklist, post a structured comment, and wait

**Why nothing shipped:** Workers hit the preflight checklist, which checked for nonexistent metadata fields → BLOCKED. Workers couldn't think "this field doesn't exist because it's not needed" — they just ran the checklist. When user said "simplify," orchestrator reran the same harness.

**Root cause:** The orchestrator agent built an elaborate validation harness instead of looking at the repo, discovering existing tools (`gj`), and doing the simple thing. The harness itself was the problem — not retries, not timeouts, not the lifecycle manager. The workers were slaves to a script that defined what to check, and what it checked was wrong.

**The anti-pattern is the harness itself.** 665 lines of bash for a 4-command task. Every joint in the Rube Goldberg machine was a potential blocker, and none of the joints could think.

**Key insight → A3 (primary) + A6 (backstop):** The fix is not "better retry caps" or "measure git output." The fix is in the orchestrator system prompt (A3): **the orchestrator must discover before prescribing, and must never build elaborate validation harnesses for simple tasks.** The weight of the solution must match the weight of the problem. A6's output-based stuck detection is the backstop for when the prompt isn't enough.

## Open Questions

(None — all questions resolved. Shape is ready to slice.)
