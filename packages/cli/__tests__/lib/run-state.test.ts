import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoist ALL mocks — these run before any module-level initializers
const { mockExecFile, testRunDir } = vi.hoisted(() => {
  const { tmpdir: _tmpdir } = require("node:os");
  const { join: _join } = require("node:path");
  return {
    mockExecFile: vi.fn(),
    testRunDir: _join(_tmpdir(), `ao-run-state-test-${process.pid}`),
  };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
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
  type RunState,
} from "../../src/lib/web-dir.js";

const RUN_STATE_DIR = join(testRunDir, "home", ".agent-orchestrator", "run");

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

function writeTestRunState(filename: string, state: Partial<RunState>): void {
  mkdirSync(RUN_STATE_DIR, { recursive: true });
  writeFileSync(join(RUN_STATE_DIR, filename), JSON.stringify(state));
}

function cleanTestDir(): void {
  if (existsSync(RUN_STATE_DIR)) {
    for (const f of readdirSync(RUN_STATE_DIR)) {
      try {
        unlinkSync(join(RUN_STATE_DIR, f));
      } catch {
        // Best effort
      }
    }
  }
}

beforeEach(() => {
  mockExecFile.mockReset();
  cleanTestDir();
});

afterEach(() => {
  cleanTestDir();
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
  });
});
