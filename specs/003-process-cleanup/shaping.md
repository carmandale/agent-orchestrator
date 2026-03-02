---
shaping: true
bead: agent-orchestrator-4
---

# Process Cleanup — Bulletproof Start/Stop/Signal Lifecycle

## Source

E2E testing session (2026-03-01) between Chip (Mac Mini, OpenClaw) and Opus (Claude Code on laptop). Three tests run: happy path start/stop, double-start guard, and SIGTERM signal cleanup. Results:

> 1. **Test 1 (happy path):** `ao start` + `ao stop` — passed. Clean start, clean stop. Lock file removed, tmux killed, ports freed.
>
> 2. **Test 2 (double-start guard):** `ao start` twice — passed. Second start correctly rejected: `"Dashboard for 'ao' is already running on port 3000. Stop it first: ao stop ao"`.
>
> 3. **Test 3 (SIGTERM cleanup):** `kill <dashboard-pid>` — **failed twice before fix.** Three distinct issues found:
>    - **Iteration 1:** Lock file cleaned up, but tmux session AND dashboard port survived. SIGTERM handler wasn't killing tmux.
>    - **Iteration 2 (after tmux fix):** Lock file cleaned up, tmux killed, but dashboard child processes (Next.js on port 3000) survived as orphans. Process group not being killed.
>    - **Iteration 3 (after process group fix):** All three clean — lock file, tmux, port 3000. ✅
>
> 4. **Persistent port leak:** Ports 14800 and 14801 (terminal WebSocket servers) leaked across EVERY start/stop cycle. Even `ao stop` didn't reliably kill them. Required manual `kill <pid>` between runs. This was the most consistent failure across all tests.
>
> 5. **`ao stop` port detection failure:** After SIGTERM killed PID 58180, `ao stop` reported "Dashboard not running on ports 3000–3010" when `lsof` clearly showed Node listening on port 3000 (PID 62155). The port-scanning fallback has a detection bug.

**Goal:** After these fixes, `ao start` / `ao stop` / `kill <pid>` all leave zero orphaned processes, zero leaked ports, zero stale lock files. Every time.

---

## Requirements (R)

| ID | Requirement | Priority |
|----|-------------|----------|
| R0 | SIGTERM to dashboard PID must clean up lock file, tmux session, AND all child processes (dashboard, terminal WS servers) | Must-have |
| R1 | `ao stop` must kill terminal WebSocket servers on ports 14800/14801 (not just dashboard on port 3000) | Must-have |
| R2 | `ao stop` port detection must correctly find processes on the configured port, even after orphaning | Must-have |
| R3 | No process leaks between start/stop cycles — every `ao stop` or SIGTERM must leave zero ao-related processes | Must-have |
| R4 | Process group kill (`kill -TERM -<pgid>`) should be the primary cleanup mechanism, with port-based fallback | Should-have |
| R5 | Run state file should track ALL spawned PIDs/ports (dashboard + terminal WS), not just dashboard | Must-have |

---

## Shape A: Process Group Lifecycle

### A0: Spawn Dashboard as Process Group Leader

**Problem:** Dashboard spawns child processes (Next.js, terminal-websocket.ts, direct-terminal-ws.ts) that become orphans when the parent is killed. Individual PID tracking can't catch dynamically spawned children.

**Mechanism:** Spawn the dashboard process with `setsid` (or Node's `detached: true` + `process.kill(-pid)` pattern) so it becomes a process group leader. All children inherit the PGID. Store the PGID in the run state file.

**Cleanup path:** `kill -TERM -<pgid>` kills the entire process tree in one call — dashboard, Next.js, all terminal WS servers, everything.

**Where:** Dashboard spawn logic + run state file write.

**Scope:** ~15 lines.

---

### A1: SIGTERM Handler Kills Process Group + Tmux

**Problem:** SIGTERM handler cleans up lock file but doesn't kill the full process group or tmux session (fixed in iterations during testing, but needs to be robust).

**Mechanism:** Register SIGTERM/SIGINT handlers that:
1. Read the run state file to get PGID and tmux session name
2. `kill -TERM -<pgid>` (kill entire process group)
3. `tmux kill-session -t <session-name>` (kill orchestrator tmux)
4. Remove run state lock file
5. Exit

Order matters: kill processes first, then clean up state files.

**Where:** Signal handler registration in start command.

**Scope:** ~20 lines.

---

### A2: Track All Ports in Run State

**Problem:** Run state file only tracks `dashboardPort`. Terminal WS ports (14800, 14801) are not tracked, so `ao stop` can't find them for fallback cleanup.

**Mechanism:** Extend run state to include:
```json
{
  "configPath": "...",
  "projectName": "...",
  "dashboardPid": 12345,
  "dashboardPort": 3000,
  "terminalPorts": [14800, 14801],
  "pgid": 12345,
  "startedAt": "...",
  "tmuxSession": "988731f19512-ao-orchestrator"
}
```

`ao stop` reads this and kills by PGID first, then verifies all listed ports are free. If any port still has a listener after PGID kill, kill those individually as a safety net.

**Where:** Run state write (start) + run state read (stop).

**Scope:** ~15 lines.

---

### A3: Fix `ao stop` Port Detection Fallback

**Problem:** `ao stop` reported "Dashboard not running on ports 3000–3010" when a Node process was clearly listening on port 3000. The port-scanning logic has a detection bug — likely checking the wrong PID or using a stale process list.

**Mechanism:** When run state file is missing (fallback path):
1. Use `lsof -i :<port> -t` to get PIDs (not `lsof -i :<port>` which needs parsing)
2. For each PID, verify it's a Node process related to ao (check command line for ao-related paths)
3. Kill verified PIDs
4. Also scan terminal WS ports (14800, 14801) with same logic

When run state file IS present (primary path): use PGID kill, then verify ports are clear.

**Where:** Stop command fallback logic.

**Scope:** ~20 lines.

---

### A4: Verify-After-Kill Safety Net

**Problem:** Even after killing, orphaned processes can survive (race conditions, zombie processes, etc.).

**Mechanism:** After the primary kill (PGID or individual), wait 2 seconds, then verify:
1. All ports from run state (or default ports) are free
2. No tmux sessions with the ao prefix exist
3. Run state file is removed

If anything survives, escalate to `SIGKILL` on remaining PIDs. Log what was force-killed.

**Where:** Stop command, after primary cleanup.

**Scope:** ~15 lines.

---

## Fit Check

| Req | Requirement | Part | Covered? |
|-----|-------------|------|----------|
| R0 | SIGTERM cleans up everything | A0 + A1 | ✅ Process group kill + tmux kill in signal handler |
| R1 | `ao stop` kills terminal WS servers | A2 + A3 | ✅ All ports tracked + fallback scans terminal ports |
| R2 | `ao stop` port detection works correctly | A3 | ✅ Fixed detection using `lsof -t` + PID verification |
| R3 | Zero process leaks between cycles | A4 | ✅ Verify-after-kill with SIGKILL escalation |
| R4 | Process group kill as primary mechanism | A0 + A1 | ✅ PGID stored and used for cleanup |
| R5 | Run state tracks all PIDs/ports | A2 | ✅ Extended run state with terminal ports + tmux session name |

---

## Effort Estimate

| Part | Complexity | Lines |
|------|-----------|-------|
| A0: Process group spawn | Small | ~15 |
| A1: SIGTERM handler | Small | ~20 |
| A2: Extended run state | Trivial | ~15 |
| A3: Fix port detection | Small | ~20 |
| A4: Verify-after-kill | Small | ~15 |
| **Total** | **Small** | **~85** |

Single slice. All parts are tightly coupled around the same run state mechanism. Ship together.

---

## Tasks

- [ ] **A0:** Modify dashboard spawn to use process group (setsid/detached), store PGID in run state
- [ ] **A1:** Register SIGTERM/SIGINT handlers that kill process group + tmux + clean lock file
- [ ] **A2:** Extend run state schema to include `terminalPorts`, `tmuxSession`, `pgid`
- [ ] **A3:** Fix `ao stop` fallback port detection — use `lsof -t`, verify PID identity, scan terminal ports
- [ ] **A4:** Add verify-after-kill step — check all ports/tmux clear, escalate to SIGKILL if needed
- [ ] **Test:** Start → SIGTERM → verify zero orphans (lock, tmux, all ports)
- [ ] **Test:** Start → `ao stop` → verify zero orphans
- [ ] **Test:** Start → `ao stop` with missing run state → fallback cleans up correctly
- [ ] **Test:** Multiple start/stop cycles → no port accumulation

## Open Questions

None. All issues observed directly during e2e testing with exact PIDs and port numbers. Ready to implement.
