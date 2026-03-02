import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

// Hoist ALL mocks — these run before any module-level initializers
const { mockExecFileSync, testRunDir } = vi.hoisted(() => {
  const { tmpdir: _tmpdir } = require("node:os");
  const { join: _join } = require("node:path");
  return {
    mockExecFileSync: vi.fn(),
    testRunDir: _join(_tmpdir(), `ao-cleanup-test-${process.pid}`),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

// Mock homedir to control RUN_STATE_DIR
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const { join: _join } = require("node:path");
  return {
    ...actual,
    homedir: () => _join(testRunDir, "home"),
  };
});

import {
  cleanupRunState,
  writeRunState,
  readRunState,
  type RunState,
} from "../../src/lib/web-dir.js";

const RUN_STATE_DIR = join(testRunDir, "home", ".agent-orchestrator", "run");
const TRASH_DIR = join(testRunDir, "home", ".Trash");

/**
 * Mock the `trash` CLI: simulate by moving the file to our test TRASH_DIR.
 */
function mockTrashCli(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "trash" && args.length > 0) {
      const filepath = args[0];
      if (existsSync(filepath)) {
        mkdirSync(TRASH_DIR, { recursive: true });
        const basename = filepath.split("/").pop() ?? "unknown";
        renameSync(filepath, join(TRASH_DIR, `${basename}.${Date.now()}`));
      }
    }
    return Buffer.from("");
  });
}

function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // Best effort
      }
    }
  }
}

function cleanTestDirs(): void {
  cleanDir(RUN_STATE_DIR);
  cleanDir(TRASH_DIR);
}

const testState: RunState = {
  configPath: "/test/config.yaml",
  projectName: "myproject",
  dashboardPid: 12345,
  dashboardPort: 3000,
  terminalPorts: [14800, 14801],
  startedAt: new Date().toISOString(),
  pgid: 12345,
  tmuxSession: "ao-test-session",
};

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockTrashCli();
  cleanTestDirs();
});

afterEach(() => {
  cleanTestDirs();
});

describe("cleanupRunState", () => {
  it("kills process group, tmux session, and deletes run state", () => {
    // Write a run state so deleteRunState has something to delete
    writeRunState(testState.configPath, testState.projectName, testState);

    // Spy on process.kill
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    cleanupRunState({
      configPath: testState.configPath,
      projectName: testState.projectName,
      pgid: testState.pgid,
      tmuxSession: testState.tmuxSession,
    });

    // Verify process group was killed (negative PID = process group)
    expect(killSpy).toHaveBeenCalledWith(-testState.pgid, "SIGTERM");

    // Verify tmux kill-session was called
    const tmuxCalls = mockExecFileSync.mock.calls.filter(
      (c: string[]) => c[0] === "tmux",
    );
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0][1]).toEqual(["kill-session", "-t", "ao-test-session"]);

    // Verify run state file was deleted (moved to trash)
    const remaining = readRunState(testState.configPath, testState.projectName);
    expect(remaining).toBeNull();

    killSpy.mockRestore();
  });

  it("handles missing pgid gracefully", () => {
    writeRunState(testState.configPath, testState.projectName, testState);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    cleanupRunState({
      configPath: testState.configPath,
      projectName: testState.projectName,
      // No pgid
      tmuxSession: testState.tmuxSession,
    });

    // process.kill should NOT have been called (no pgid)
    expect(killSpy).not.toHaveBeenCalled();

    // tmux should still be killed
    const tmuxCalls = mockExecFileSync.mock.calls.filter(
      (c: string[]) => c[0] === "tmux",
    );
    expect(tmuxCalls).toHaveLength(1);

    killSpy.mockRestore();
  });

  it("handles missing tmuxSession gracefully", () => {
    writeRunState(testState.configPath, testState.projectName, testState);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    cleanupRunState({
      configPath: testState.configPath,
      projectName: testState.projectName,
      pgid: testState.pgid,
      // No tmuxSession
    });

    // process.kill should have been called
    expect(killSpy).toHaveBeenCalledWith(-testState.pgid, "SIGTERM");

    // tmux should NOT have been called
    const tmuxCalls = mockExecFileSync.mock.calls.filter(
      (c: string[]) => c[0] === "tmux",
    );
    expect(tmuxCalls).toHaveLength(0);

    killSpy.mockRestore();
  });

  it("still deletes run state even if pgid kill fails", () => {
    writeRunState(testState.configPath, testState.projectName, testState);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    // Should not throw
    cleanupRunState({
      configPath: testState.configPath,
      projectName: testState.projectName,
      pgid: testState.pgid,
      tmuxSession: testState.tmuxSession,
    });

    // Run state should still be deleted
    const remaining = readRunState(testState.configPath, testState.projectName);
    expect(remaining).toBeNull();

    killSpy.mockRestore();
  });

  it("still deletes run state even if tmux kill fails", () => {
    writeRunState(testState.configPath, testState.projectName, testState);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // Make tmux kill-session throw, but trash still works
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux") {
        throw new Error("tmux not running");
      }
      // Still handle trash
      if (cmd === "trash" && args.length > 0) {
        const filepath = args[0];
        if (existsSync(filepath)) {
          mkdirSync(TRASH_DIR, { recursive: true });
          const basename = filepath.split("/").pop() ?? "unknown";
          renameSync(filepath, join(TRASH_DIR, `${basename}.${Date.now()}`));
        }
      }
      return Buffer.from("");
    });

    cleanupRunState({
      configPath: testState.configPath,
      projectName: testState.projectName,
      pgid: testState.pgid,
      tmuxSession: testState.tmuxSession,
    });

    // Run state should still be deleted
    const remaining = readRunState(testState.configPath, testState.projectName);
    expect(remaining).toBeNull();

    killSpy.mockRestore();
  });
});
