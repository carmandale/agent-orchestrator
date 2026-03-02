import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  execFileSync: vi.fn(),
}));

import { isAoProcess, validateAoProcessIdentity } from "../../src/lib/process-identity.js";

function mockPsOutput(stdout: string): void {
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

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("isAoProcess", () => {
  it("returns true for an ao-web process", async () => {
    mockPsOutput("node /path/to/ao-web/server.js\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns true for an agent-orchestrator process", async () => {
    mockPsOutput("/usr/local/bin/node agent-orchestrator/packages/web\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns true for a terminal-websocket process", async () => {
    mockPsOutput("node terminal-websocket-server.js\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns true for a direct-terminal-ws process", async () => {
    mockPsOutput("node direct-terminal-ws.js\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns true for a next dev process", async () => {
    mockPsOutput("node /path/to/.bin/next dev\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns true for a next-server process", async () => {
    mockPsOutput("/usr/local/bin/node next-server --port 3000\n");
    expect(await isAoProcess(1234)).toBe(true);
  });

  it("returns false for an unrelated process", async () => {
    mockPsOutput("/usr/bin/python3 -m http.server 3000\n");
    expect(await isAoProcess(1234)).toBe(false);
  });

  it("returns false for a dead process", async () => {
    mockPsFailure();
    expect(await isAoProcess(999999999)).toBe(false);
  });

  it("returns false for empty output", async () => {
    mockPsOutput("");
    expect(await isAoProcess(1234)).toBe(false);
  });
});

describe("validateAoProcessIdentity", () => {
  it("returns true when command matches and no start time check needed", async () => {
    mockPsOutput("node ao-web/server.js\n");
    expect(await validateAoProcessIdentity(1234)).toBe(true);
  });

  it("returns false when command does not match ao patterns", async () => {
    mockPsOutput("/usr/bin/vim\n");
    expect(await validateAoProcessIdentity(1234)).toBe(false);
  });

  it("returns true when command matches and start time matches", async () => {
    // First call: ps -o command= returns ao process
    // Second call: ps -o lstart= returns matching start time
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          // command= check
          cb(null, { stdout: "node agent-orchestrator/server.js\n", stderr: "" });
        } else {
          // lstart= check
          cb(null, { stdout: "Thu Jan  1 00:00:00 2026", stderr: "" });
        }
      },
    );

    expect(await validateAoProcessIdentity(1234, "Thu Jan  1 00:00:00 2026")).toBe(true);
  });

  it("returns false when command matches but start time differs (PID recycled)", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          cb(null, { stdout: "node agent-orchestrator/server.js\n", stderr: "" });
        } else {
          cb(null, { stdout: "Fri Feb  2 12:34:56 2026", stderr: "" });
        }
      },
    );

    expect(await validateAoProcessIdentity(1234, "Thu Jan  1 00:00:00 2026")).toBe(false);
  });

  it("returns false when process is dead", async () => {
    mockPsFailure();
    expect(await validateAoProcessIdentity(999999999, "Thu Jan  1 00:00:00 2026")).toBe(false);
  });
});
