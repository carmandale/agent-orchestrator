import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoist ALL mocks — these run before any module-level initializers
const { mockExecFile, mockExecFileSync, testRunDir } = vi.hoisted(() => {
  const { tmpdir: _tmpdir } = require("node:os");
  const { join: _join } = require("node:path");
  return {
    mockExecFile: vi.fn(),
    mockExecFileSync: vi.fn(),
    testRunDir: _join(_tmpdir(), `ao-run-state-test-${process.pid}`),
  };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
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
  getProcessStartTime,
  isRunStateLive,
  listAllRunStates,
  sweepStaleRunStates,
  deleteRunState,
  writeRunState,
  type RunState,
} from "../../src/lib/web-dir.js";

const RUN_STATE_DIR = join(testRunDir, "home", ".agent-orchestrator", "run");
const TRASH_DIR = join(testRunDir, "home", ".Trash");

function mockPsSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

function mockPsFailure(): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error("No such process"));
    },
  );
}

/**
 * Mock the `trash` CLI: simulate by moving the file to our test TRASH_DIR.
 * This mimics what the real `trash` command does (move to ~/.Trash).
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

function writeTestRunState(filename: string, state: Partial<RunState>): void {
  mkdirSync(RUN_STATE_DIR, { recursive: true });
  writeFileSync(join(RUN_STATE_DIR, filename), JSON.stringify(state));
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

beforeEach(() => {
  mockExecFile.mockReset();
  mockExecFileSync.mockReset();
  mockTrashCli();
  cleanTestDirs();
});

afterEach(() => {
  cleanTestDirs();
});

describe("getProcessStartTime", () => {
  it("returns start time for a live PID", async () => {
    mockPsSuccess("  Thu Jan  1 00:00:00 2026\n");
    const result = await getProcessStartTime(process.pid);
    expect(result).toBe("Thu Jan  1 00:00:00 2026");
  });

  it("returns null for a dead PID", async () => {
    mockPsFailure();
    const result = await getProcessStartTime(999999999);
    expect(result).toBeNull();
  });
});

describe("isRunStateLive", () => {
  it("returns true for a live PID with matching start time", async () => {
    mockPsSuccess("  Thu Jan  1 00:00:00 2026\n");
    // Use current process PID so signal 0 succeeds
    const state: RunState = {
      configPath: "/tmp/config.yaml",
      projectName: "test",
      dashboardPid: process.pid,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: new Date().toISOString(),
      pgid: process.pid,
      processStartTime: "Thu Jan  1 00:00:00 2026",
    };
    const result = await isRunStateLive(state);
    expect(result).toBe(true);
  });

  it("returns false when start time does not match (PID recycled)", async () => {
    mockPsSuccess("  Fri Feb  2 12:34:56 2026\n");
    const state: RunState = {
      configPath: "/tmp/config.yaml",
      projectName: "test",
      dashboardPid: process.pid,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: new Date().toISOString(),
      pgid: process.pid,
      processStartTime: "Thu Jan  1 00:00:00 2026",
    };
    const result = await isRunStateLive(state);
    expect(result).toBe(false);
  });

  it("returns false for a dead PID", async () => {
    mockPsFailure();
    const state: RunState = {
      configPath: "/tmp/config.yaml",
      projectName: "test",
      dashboardPid: 999999999,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: new Date().toISOString(),
      pgid: 999999999,
    };
    const result = await isRunStateLive(state);
    expect(result).toBe(false);
  });

  it("returns true for a live PID with no processStartTime (backwards compat)", async () => {
    const state: RunState = {
      configPath: "/tmp/config.yaml",
      projectName: "test",
      dashboardPid: process.pid,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: new Date().toISOString(),
      pgid: process.pid,
    };
    const result = await isRunStateLive(state);
    expect(result).toBe(true);
  });
});

describe("listAllRunStates", () => {
  it("returns parsed run state files", () => {
    writeTestRunState("abc123.json", {
      configPath: "/a",
      projectName: "p1",
      dashboardPid: 1234,
      pgid: 1234,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });
    writeTestRunState("def456.json", {
      configPath: "/b",
      projectName: "p2",
      dashboardPid: 5678,
      pgid: 5678,
      dashboardPort: 3001,
      terminalPorts: [],
      startedAt: "2026-01-02",
    });
    const result = listAllRunStates();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.state.projectName).sort()).toEqual(["p1", "p2"]);
  });

  it("skips corrupt files", () => {
    writeTestRunState("good.json", {
      configPath: "/a",
      projectName: "p1",
      dashboardPid: 1234,
      pgid: 1234,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });
    writeTestRunState("another.json", {
      configPath: "/b",
      projectName: "p2",
      dashboardPid: 5678,
      pgid: 5678,
      dashboardPort: 3001,
      terminalPorts: [],
      startedAt: "2026-01-02",
    });
    // Write a corrupt file
    mkdirSync(RUN_STATE_DIR, { recursive: true });
    writeFileSync(join(RUN_STATE_DIR, "corrupt.json"), "not valid json{{{");

    const result = listAllRunStates();
    expect(result).toHaveLength(2);
  });

  it("returns empty array when directory does not exist", () => {
    const result = listAllRunStates();
    expect(result).toEqual([]);
  });
});

describe("sweepStaleRunStates", () => {
  it("removes dead entries and keeps live ones", async () => {
    // Write entries — all use PID 999999999 (dead) except one using current PID
    writeTestRunState("dead1.json", {
      configPath: "/a",
      projectName: "d1",
      dashboardPid: 999999999,
      pgid: 999999999,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });
    writeTestRunState("dead2.json", {
      configPath: "/b",
      projectName: "d2",
      dashboardPid: 999999998,
      pgid: 999999998,
      dashboardPort: 3001,
      terminalPorts: [],
      startedAt: "2026-01-02",
    });
    writeTestRunState("live.json", {
      configPath: "/c",
      projectName: "alive",
      dashboardPid: process.pid,
      pgid: process.pid,
      dashboardPort: 3002,
      terminalPorts: [],
      startedAt: "2026-01-03",
    });

    const cleaned = await sweepStaleRunStates();
    expect(cleaned).toBe(2);

    // Only the live entry should remain
    const remaining = listAllRunStates();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].state.projectName).toBe("alive");

    // Verify trash CLI was called for each dead file
    const trashCalls = mockExecFileSync.mock.calls.filter(
      (c: string[]) => c[0] === "trash",
    );
    expect(trashCalls).toHaveLength(2);

    // Verify dead files were moved to Trash
    const trashedFiles = readdirSync(TRASH_DIR);
    expect(trashedFiles.length).toBe(2);
  });
});

describe("deleteRunState", () => {
  it("calls trash CLI to move file", () => {
    writeTestRunState("test-delete.json", {
      configPath: "/test/config.yaml",
      projectName: "myproject",
      dashboardPid: 1234,
      pgid: 1234,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });

    // The hash-based filename won't match "test-delete.json" —
    // use the actual function which computes the hash
    deleteRunState("/test/config.yaml", "myproject");

    // test-delete.json remains (wrong hash name), hash-named file was trashed
    const remaining = listAllRunStates();
    expect(remaining).toHaveLength(1);

    // Verify trash was called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "trash",
      expect.arrayContaining([expect.stringContaining(".json")]),
      expect.any(Object),
    );
  });

  it("moves the correct hash-named file to Trash", () => {
    writeRunState("/my/config.yaml", "proj1", {
      configPath: "/my/config.yaml",
      projectName: "proj1",
      dashboardPid: 9999,
      pgid: 9999,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });

    // Verify it exists
    const before = readdirSync(RUN_STATE_DIR).filter((f) => f.endsWith(".json"));
    expect(before.length).toBeGreaterThanOrEqual(1);

    deleteRunState("/my/config.yaml", "proj1");

    // File should be gone from run state dir
    const after = readdirSync(RUN_STATE_DIR).filter((f) => f.endsWith(".json"));
    expect(after.length).toBe(before.length - 1);

    // File should be in Trash
    const trashed = readdirSync(TRASH_DIR);
    expect(trashed.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to unlink when trash CLI is unavailable", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("trash: command not found");
    });

    writeRunState("/fallback/config.yaml", "proj2", {
      configPath: "/fallback/config.yaml",
      projectName: "proj2",
      dashboardPid: 9999,
      pgid: 9999,
      dashboardPort: 3000,
      terminalPorts: [],
      startedAt: "2026-01-01",
    });

    const before = readdirSync(RUN_STATE_DIR).filter((f) => f.endsWith(".json"));
    expect(before.length).toBeGreaterThanOrEqual(1);

    deleteRunState("/fallback/config.yaml", "proj2");

    // File should still be gone (via unlinkSync fallback)
    const after = readdirSync(RUN_STATE_DIR).filter((f) => f.endsWith(".json"));
    expect(after.length).toBe(before.length - 1);
  });
});
