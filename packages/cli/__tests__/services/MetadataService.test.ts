import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @composio/ao-core metadata functions
const {
  mockReadMetadata,
  mockWriteMetadata,
  mockUpdateMetadata,
  mockDeleteMetadata,
  mockListMetadata,
  mockReadMetadataRaw,
} = vi.hoisted(() => ({
  mockReadMetadata: vi.fn(),
  mockWriteMetadata: vi.fn(),
  mockUpdateMetadata: vi.fn(),
  mockDeleteMetadata: vi.fn(),
  mockListMetadata: vi.fn(),
  mockReadMetadataRaw: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  readMetadata: mockReadMetadata,
  writeMetadata: mockWriteMetadata,
  updateMetadata: mockUpdateMetadata,
  deleteMetadata: mockDeleteMetadata,
  listMetadata: mockListMetadata,
  readMetadataRaw: mockReadMetadataRaw,
}));

import { MetadataService } from "../../src/services/MetadataService.js";

describe("MetadataService", () => {
  let service: MetadataService;
  const sessionsDir = "/data/sessions";

  beforeEach(() => {
    service = new MetadataService(sessionsDir);
    vi.clearAllMocks();
  });

  describe("read", () => {
    it("should delegate to core readMetadata with sessionsDir", () => {
      const metadata = { worktree: "/w", branch: "main", status: "working" };
      mockReadMetadata.mockReturnValue(metadata);

      const result = service.read("session-1");

      expect(mockReadMetadata).toHaveBeenCalledWith(sessionsDir, "session-1");
      expect(result).toBe(metadata);
    });

    it("should return null when session does not exist", () => {
      mockReadMetadata.mockReturnValue(null);

      const result = service.read("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("readRaw", () => {
    it("should delegate to core readMetadataRaw", () => {
      const raw = { worktree: "/w", customField: "value" };
      mockReadMetadataRaw.mockReturnValue(raw);

      const result = service.readRaw("session-1");

      expect(mockReadMetadataRaw).toHaveBeenCalledWith(sessionsDir, "session-1");
      expect(result).toBe(raw);
    });
  });

  describe("write", () => {
    it("should delegate to core writeMetadata", () => {
      const metadata = { worktree: "/w", branch: "main", status: "working" };

      service.write("session-1", metadata);

      expect(mockWriteMetadata).toHaveBeenCalledWith(sessionsDir, "session-1", metadata);
    });
  });

  describe("update", () => {
    it("should delegate to core updateMetadata", () => {
      const updates = { status: "idle", pr: "https://github.com/pr/1" };

      service.update("session-1", updates);

      expect(mockUpdateMetadata).toHaveBeenCalledWith(sessionsDir, "session-1", updates);
    });
  });

  describe("delete", () => {
    it("should delegate to core deleteMetadata with archive=true by default", () => {
      service.delete("session-1");

      expect(mockDeleteMetadata).toHaveBeenCalledWith(sessionsDir, "session-1", true);
    });

    it("should pass archive=false when specified", () => {
      service.delete("session-1", false);

      expect(mockDeleteMetadata).toHaveBeenCalledWith(sessionsDir, "session-1", false);
    });
  });

  describe("list", () => {
    it("should delegate to core listMetadata", () => {
      mockListMetadata.mockReturnValue(["session-1", "session-2"]);

      const result = service.list();

      expect(mockListMetadata).toHaveBeenCalledWith(sessionsDir);
      expect(result).toEqual(["session-1", "session-2"]);
    });
  });

  describe("findByIssue", () => {
    it("should find session by issue ID (case-insensitive)", () => {
      mockListMetadata.mockReturnValue(["s-1", "s-2"]);
      mockReadMetadata
        .mockReturnValueOnce({ worktree: "/w", branch: "b", status: "working", issue: "INT-100" })
        .mockReturnValueOnce({ worktree: "/w", branch: "b", status: "working", issue: "INT-200" });

      const result = service.findByIssue("int-200", ["s-1", "s-2"]);
      expect(result).toBe("s-2");
    });

    it("should return null when no session matches", () => {
      mockListMetadata.mockReturnValue(["s-1"]);
      mockReadMetadata.mockReturnValue({
        worktree: "/w",
        branch: "b",
        status: "working",
        issue: "INT-100",
      });

      const result = service.findByIssue("INT-999", ["s-1"]);
      expect(result).toBeNull();
    });

    it("should skip sessions not in activeSessions list", () => {
      mockListMetadata.mockReturnValue(["s-1"]);
      mockReadMetadata.mockReturnValue({
        worktree: "/w",
        branch: "b",
        status: "working",
        issue: "INT-100",
      });

      // s-1 has the issue but is not in activeSessions (only s-2 is active)
      const result = service.findByIssue("INT-100", ["s-2"]);
      expect(result).toBeNull();
    });

    it("should filter by projectId when specified", () => {
      mockListMetadata.mockReturnValue(["s-1", "s-2"]);
      mockReadMetadata
        .mockReturnValueOnce({
          worktree: "/w",
          branch: "b",
          status: "working",
          issue: "INT-100",
          project: "proj-a",
        })
        .mockReturnValueOnce({
          worktree: "/w",
          branch: "b",
          status: "working",
          issue: "INT-100",
          project: "proj-b",
        });

      const result = service.findByIssue("INT-100", ["s-1", "s-2"], "proj-b");
      expect(result).toBe("s-2");
    });
  });

  describe("getSessionsDir", () => {
    it("should return the sessionsDir passed at construction", () => {
      expect(service.getSessionsDir()).toBe(sessionsDir);
    });
  });
});
