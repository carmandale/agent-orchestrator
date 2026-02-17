/**
 * Dashboard rebuild utility — cleans stale build artifacts and rebuilds.
 *
 * Handles three common failure modes:
 * 1. Stale .next cache (e.g., missing vendor-chunks after dependency changes)
 * 2. Missing node_modules in web package
 * 3. Missing built packages (core/plugins not compiled)
 */

import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { exec } from "./shell.js";

/**
 * Find the monorepo root by walking up from the web directory.
 * Looks for pnpm-workspace.yaml as the marker.
 */
function findMonorepoRoot(webDir: string): string | null {
  let dir = resolve(webDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Clean stale .next cache and rebuild all packages.
 */
export async function rebuildDashboard(webDir: string): Promise<void> {
  const nextDir = resolve(webDir, ".next");
  const spinner = ora();

  // Step 1: Clean .next cache
  if (existsSync(nextDir)) {
    spinner.start("Cleaning .next build cache");
    rmSync(nextDir, { recursive: true, force: true });
    spinner.succeed("Cleaned .next build cache");
  }

  // Step 2: Ensure node_modules exist
  if (!existsSync(resolve(webDir, "node_modules"))) {
    const root = findMonorepoRoot(webDir);
    if (root) {
      spinner.start("Installing dependencies (pnpm install)");
      await exec("pnpm", ["install"], { cwd: root });
      spinner.succeed("Dependencies installed");
    }
  }

  // Step 3: Build workspace packages (core + plugins)
  const root = findMonorepoRoot(webDir);
  if (root) {
    spinner.start("Building packages (pnpm build)");
    await exec("pnpm", ["build"], { cwd: root });
    spinner.succeed("Packages built");
  }

  console.log(chalk.green("\nRebuild complete.\n"));
}
