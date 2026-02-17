import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shell exec
const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

import { ProcessManager } from "../../src/services/ProcessManager.js";

describe("ProcessManager", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    mockExec.mockReset();
  });

  describe("killByPorts", () => {
    it("should find and kill processes on specified ports", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 3000
        .mockResolvedValueOnce({ stdout: "67890\n" }) // port 3001
        .mockResolvedValue({ stdout: "" }); // kill call

      const killed = await pm.killByPorts([3000, 3001]);

      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":3000"]);
      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":3001"]);
      expect(mockExec).toHaveBeenCalledWith("kill", ["12345", "67890"]);
      expect(killed).toEqual(["12345", "67890"]);
    });

    it("should deduplicate PIDs across ports", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 3000
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 3001 (same PID)
        .mockResolvedValue({ stdout: "" }); // kill call

      const killed = await pm.killByPorts([3000, 3001]);

      const killCall = mockExec.mock.calls.find(
        (call: unknown[]) => call[0] === "kill",
      );
      expect(killCall![1]).toEqual(["12345"]);
      expect(killed).toEqual(["12345"]);
    });

    it("should return empty array when no processes found", async () => {
      mockExec.mockRejectedValue(new Error("no match"));

      const killed = await pm.killByPorts([3000, 3001]);

      expect(killed).toEqual([]);
      // Should not call kill
      expect(mockExec).not.toHaveBeenCalledWith("kill", expect.anything());
    });

    it("should handle mixed port states (some in use, some not)", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 3000 in use
        .mockRejectedValueOnce(new Error("no match")) // port 3001 not in use
        .mockResolvedValue({ stdout: "" }); // kill call

      const killed = await pm.killByPorts([3000, 3001]);

      expect(killed).toEqual(["12345"]);
    });

    it("should handle kill failures gracefully", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "12345\n" })
        .mockRejectedValueOnce(new Error("no such process")); // kill fails

      // Should not throw
      const killed = await pm.killByPorts([3000]);
      expect(killed).toEqual(["12345"]);
    });
  });

  describe("isPortInUse", () => {
    it("should return true when process is on port", async () => {
      mockExec.mockResolvedValue({ stdout: "12345\n" });

      const result = await pm.isPortInUse(3000);
      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":3000"]);
    });

    it("should return false when no process on port", async () => {
      mockExec.mockRejectedValue(new Error("no match"));

      const result = await pm.isPortInUse(3000);
      expect(result).toBe(false);
    });

    it("should return false for empty stdout", async () => {
      mockExec.mockResolvedValue({ stdout: "\n" });

      const result = await pm.isPortInUse(3000);
      expect(result).toBe(false);
    });
  });
});
