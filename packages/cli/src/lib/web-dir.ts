/**
 * Web directory locator — finds the @composio/ao-web package.
 * Shared utility to avoid duplication between dashboard.ts and start.ts.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * Build environment variables for spawning the dashboard process.
 * Shared between `ao start` and `ao dashboard` to avoid duplication.
 *
 * Terminal server ports default to 3001/3003 but can be overridden via config
 * to allow multiple dashboard instances to run simultaneously (e.g., different
 * projects on different ports without EADDRINUSE conflicts).
 */
export function buildDashboardEnv(
  port: number,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Pass config path so dashboard uses the same config as the CLI
  if (configPath) {
    env["AO_CONFIG_PATH"] = configPath;
  }

  // Set ports for client-side access (Next.js requires NEXT_PUBLIC_ prefix)
  // Priority: config value > env var > default
  env["PORT"] = String(port);

  const resolvedTerminalPort = String(terminalPort ?? env["TERMINAL_PORT"] ?? "3001");
  const resolvedDirectTerminalPort = String(
    directTerminalPort ?? env["DIRECT_TERMINAL_PORT"] ?? "3003",
  );

  env["TERMINAL_PORT"] = resolvedTerminalPort;
  env["DIRECT_TERMINAL_PORT"] = resolvedDirectTerminalPort;
  env["NEXT_PUBLIC_TERMINAL_PORT"] = resolvedTerminalPort;
  env["NEXT_PUBLIC_DIRECT_TERMINAL_PORT"] = resolvedDirectTerminalPort;

  return env;
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
