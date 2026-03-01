/**
 * Web directory locator — finds the @composio/ao-web package.
 * Shared utility to avoid duplication between dashboard.ts and start.ts.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { execSilent } from "./shell.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

/** Default terminal server base port (14800 range: zero IANA registrations, no dev tool conflicts) */
const DEFAULT_TERMINAL_PORT = 14800;

/**
 * Check if a TCP port is available by attempting to bind to it.
 * Returns true if the port is free, false if in use.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find a pair of consecutive available ports starting from `base`.
 * Scans upward in steps of 2 (keeping ports paired) until both are free.
 * Returns [terminalPort, directTerminalPort].
 */
async function findAvailablePortPair(base: number): Promise<[number, number]> {
  const MAX_ATTEMPTS = 50;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const p1 = base + i * 2;
    const p2 = p1 + 1;
    const [free1, free2] = await Promise.all([isPortAvailable(p1), isPortAvailable(p2)]);
    if (free1 && free2) {
      return [p1, p2];
    }
  }
  // If all 50 pairs exhausted, fall back to the base (will fail at bind time with clear error)
  return [base, base + 1];
}

/**
 * Build environment variables for spawning the dashboard process.
 * Shared between `ao start` and `ao dashboard` to avoid duplication.
 *
 * Terminal server ports default to 14800/14801 but can be overridden via config.
 * When no explicit port is set, auto-detects available ports to allow multiple
 * dashboard instances to run simultaneously without EADDRINUSE conflicts.
 */
export async function buildDashboardEnv(
  port: number,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Pass config path so dashboard uses the same config as the CLI
  if (configPath) {
    env["AO_CONFIG_PATH"] = configPath;
  }

  env["PORT"] = String(port);

  // If explicit ports provided (config or env var), use them directly.
  // Otherwise, auto-detect an available pair starting from the default.
  const explicitTerminal = terminalPort ?? (env["TERMINAL_PORT"] ? parseInt(env["TERMINAL_PORT"], 10) : undefined);
  const explicitDirect = directTerminalPort ?? (env["DIRECT_TERMINAL_PORT"] ? parseInt(env["DIRECT_TERMINAL_PORT"], 10) : undefined);

  let resolvedTerminal: number;
  let resolvedDirect: number;

  if (explicitTerminal !== undefined && explicitDirect !== undefined) {
    // Both explicitly set — use as-is
    resolvedTerminal = explicitTerminal;
    resolvedDirect = explicitDirect;
  } else if (explicitTerminal !== undefined) {
    // Terminal port set, derive direct from it
    resolvedTerminal = explicitTerminal;
    resolvedDirect = explicitTerminal + 1;
  } else if (explicitDirect !== undefined) {
    // Direct port set, derive terminal from it
    resolvedTerminal = explicitDirect - 1;
    resolvedDirect = explicitDirect;
  } else {
    // Neither set — auto-detect available pair
    [resolvedTerminal, resolvedDirect] = await findAvailablePortPair(DEFAULT_TERMINAL_PORT);
  }

  env["TERMINAL_PORT"] = String(resolvedTerminal);
  env["DIRECT_TERMINAL_PORT"] = String(resolvedDirect);
  env["NEXT_PUBLIC_TERMINAL_PORT"] = String(resolvedTerminal);
  env["NEXT_PUBLIC_DIRECT_TERMINAL_PORT"] = String(resolvedDirect);

  return env;
}

// =============================================================================
// RUN STATE — persists dashboard port + PIDs for reliable cleanup
// =============================================================================

const RUN_STATE_DIR = join(homedir(), ".agent-orchestrator", "run");

/** Hash-based run state filename to prevent path injection from unconstrained project keys. */
function runStateFilename(configPath: string, projectName: string): string {
  const hash = createHash("sha256")
    .update(`${configPath}:${projectName}`)
    .digest("hex")
    .slice(0, 16);
  return `${hash}.json`;
}

export interface RunState {
  configPath: string;
  projectName: string;
  dashboardPid: number;
  dashboardPort: number;
  terminalPorts: number[];
  startedAt: string;
  pgid: number;
  /** Process start time from `ps -o lstart=`. Used to detect PID recycling. */
  processStartTime?: string;
}

/** Write run state atomically (write to .tmp, rename). */
export function writeRunState(configPath: string, projectName: string, state: RunState): void {
  mkdirSync(RUN_STATE_DIR, { recursive: true, mode: 0o700 });
  const filename = runStateFilename(configPath, projectName);
  const filepath = join(RUN_STATE_DIR, filename);
  const tmpPath = `${filepath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filepath);
}

/** Read run state, or null if missing/corrupt. */
export function readRunState(configPath: string, projectName: string): RunState | null {
  const filename = runStateFilename(configPath, projectName);
  const filepath = join(RUN_STATE_DIR, filename);
  if (!existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf-8")) as RunState;
  } catch {
    return null;
  }
}

/** Move a file to ~/.Trash/ instead of deleting it. Appends a timestamp to avoid collisions. */
function trashFile(filepath: string): void {
  const trashDir = join(homedir(), ".Trash");
  mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const basename = filepath.split("/").pop() ?? "unknown";
  const trashName = `${basename}.${Date.now()}`;
  try {
    renameSync(filepath, join(trashDir, trashName));
  } catch {
    // Cross-device or already gone — fall back to unlink as last resort
    try {
      unlinkSync(filepath);
    } catch {
      // Already gone — fine
    }
  }
}

/** Delete run state file (moves to Trash for disaster recovery). */
export function deleteRunState(configPath: string, projectName: string): void {
  const filename = runStateFilename(configPath, projectName);
  const filepath = join(RUN_STATE_DIR, filename);
  trashFile(filepath);
}

/** Get the process start time via `ps -o lstart=`. Returns null if the process doesn't exist. */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  const output = await execSilent("ps", ["-o", "lstart=", "-p", String(pid)]);
  return output?.trim() || null;
}

/** Check if a run state's process is still alive (not recycled). */
export async function isRunStateLive(state: RunState): Promise<boolean> {
  try {
    process.kill(state.pgid, 0); // signal 0 = check existence
  } catch {
    return false;
  }

  // If we recorded start time, verify it still matches (PID recycling guard)
  if (state.processStartTime) {
    const currentStartTime = await getProcessStartTime(state.dashboardPid);
    if (currentStartTime !== state.processStartTime) {
      return false;
    }
  }

  return true;
}

/** List all run state files. Skips corrupt/unparseable files. */
export function listAllRunStates(): Array<{ filename: string; state: RunState }> {
  if (!existsSync(RUN_STATE_DIR)) return [];

  const results: Array<{ filename: string; state: RunState }> = [];
  let entries: string[];
  try {
    entries = readdirSync(RUN_STATE_DIR);
  } catch {
    return [];
  }

  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    try {
      const content = readFileSync(join(RUN_STATE_DIR, filename), "utf-8");
      const state = JSON.parse(content) as RunState;
      // Basic shape validation
      if (typeof state.dashboardPid === "number" && typeof state.pgid === "number") {
        results.push({ filename, state });
      }
    } catch {
      // Corrupt file — skip
    }
  }

  return results;
}

/** Remove run state files whose processes are no longer alive. Returns count trashed. */
export async function sweepStaleRunStates(): Promise<number> {
  const all = listAllRunStates();
  let cleaned = 0;

  for (const { filename, state } of all) {
    const live = await isRunStateLive(state);
    if (!live) {
      trashFile(join(RUN_STATE_DIR, filename));
      cleaned++;
    }
  }

  return cleaned;
}

// =============================================================================
// DASHBOARD PORT SCANNING
// =============================================================================

/**
 * Find an available dashboard port, starting from `preferred`.
 * Scans preferred through preferred+10. Returns the first available port.
 * Throws if no port is available in the range.
 */
export async function findAvailableDashboardPort(preferred: number): Promise<number> {
  for (let offset = 0; offset <= 10; offset++) {
    const port = preferred + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No available port in range ${preferred}–${preferred + 10}. ` +
    `Free a port or set a different port in agent-orchestrator.yaml.`,
  );
}

/**
 * Locate the @composio/ao-web package directory.
 * Uses createRequire for ESM-compatible require.resolve, with fallback
 * to sibling package paths that work from both src/ and dist/.
 */
export function findWebDir(): string {
  // Try to resolve from node_modules first (installed as workspace dep)
  try {
    const pkgJson = require.resolve("@composio/ao-web/package.json");
    return resolve(pkgJson, "..");
  } catch {
    // Fallback: sibling package in monorepo (works both from src/ and dist/)
    // packages/cli/src/lib/ → packages/web
    // packages/cli/dist/lib/ → packages/web
    const candidates = [
      resolve(__dirname, "../../../web"),
      resolve(__dirname, "../../../../packages/web"),
    ];
    for (const candidate of candidates) {
      if (existsSync(resolve(candidate, "package.json"))) {
        return candidate;
      }
    }
    return candidates[0];
  }
}
