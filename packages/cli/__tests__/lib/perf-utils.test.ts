import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLoadConfig, mockResolveProjectLogDir, mockReadLogsFromDir } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveProjectLogDir: vi.fn(),
  mockReadLogsFromDir: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  resolveProjectLogDir: mockResolveProjectLogDir,
  readLogsFromDir: mockReadLogsFromDir,
}));

import { resolveLogDir, loadRequests, type ParsedRequest } from "../../src/lib/perf-utils.js";

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockResolveProjectLogDir.mockReset();
  mockReadLogsFromDir.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveLogDir", () => {
  it("throws when no projects configured (resolveProjectLogDir returns null)", () => {
    mockLoadConfig.mockReturnValue({ projects: {} });
    mockResolveProjectLogDir.mockReturnValue(null);

    expect(() => resolveLogDir()).toThrow("No projects configured");
  });

  it("returns directory path when configured", () => {
    mockLoadConfig.mockReturnValue({ projects: { app: {} } });
    mockResolveProjectLogDir.mockReturnValue("/tmp/logs");

    expect(resolveLogDir()).toBe("/tmp/logs");
  });
});

describe("loadRequests", () => {
  it("parses log entries into ParsedRequest objects", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "request",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 200,
          durationMs: 45,
        },
      },
    ]);

    const result = loadRequests("/tmp/logs");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<ParsedRequest>({
      ts: "2025-01-01T00:00:00Z",
      method: "GET",
      path: "/api/sessions",
      statusCode: 200,
      durationMs: 45,
      error: undefined,
      timings: undefined,
      cacheStats: undefined,
    });
  });

  it("skips entries without method/path", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "startup",
        data: { msg: "server ready" },
      },
      {
        ts: "2025-01-01T00:00:01Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "request",
        data: {
          method: "POST",
          path: "/api/sessions",
          statusCode: 201,
          durationMs: 120,
        },
      },
    ]);

    const result = loadRequests("/tmp/logs");
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("POST");
  });

  it("filters by route when opts.route is set", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "request",
        data: { method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 10 },
      },
      {
        ts: "2025-01-01T00:00:01Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "request",
        data: { method: "GET", path: "/api/health", statusCode: 200, durationMs: 5 },
      },
    ]);

    const result = loadRequests("/tmp/logs", { route: "/api/sessions" });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/api/sessions");
  });

  it("returns empty array when no matching entries", () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const result = loadRequests("/tmp/logs");
    expect(result).toEqual([]);
  });

  it("includes timings and cacheStats when present", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "request",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 200,
          durationMs: 100,
          timings: { prEnrichment: 50, sessionList: 30 },
          cacheStats: { hits: 10, misses: 2, hitRate: 0.83, size: 12 },
        },
      },
    ]);

    const result = loadRequests("/tmp/logs");
    expect(result[0].timings).toEqual({ prEnrichment: 50, sessionList: 30 });
    expect(result[0].cacheStats).toEqual({ hits: 10, misses: 2, hitRate: 0.83, size: 12 });
  });

  it("includes error field when present", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T00:00:00Z",
        level: "error",
        source: "api",
        sessionId: null,
        message: "request failed",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 500,
          durationMs: 200,
          error: "Internal Server Error",
        },
      },
    ]);

    const result = loadRequests("/tmp/logs");
    expect(result[0].error).toBe("Internal Server Error");
    expect(result[0].statusCode).toBe(500);
  });
});
