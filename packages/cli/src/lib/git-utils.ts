/**
 * Git utilities for CLI commands.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/**
 * Detect the default branch for a git repository.
 *
 * Detection cascade:
 * 1. `git symbolic-ref refs/remotes/origin/HEAD` → parse branch name
 * 2. Fallback: `git rev-parse --abbrev-ref HEAD` → use current branch
 * 3. Final fallback: "main"
 */
export async function detectDefaultBranch(projectPath: string): Promise<string> {
  // 1. Try symbolic-ref (most reliable when origin is configured)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "symbolic-ref", "refs/remotes/origin/HEAD"],
      { timeout: 10_000 },
    );
    const ref = stdout.trim(); // e.g. "refs/remotes/origin/main"
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (branch && branch !== ref) {
      return branch;
    }
  } catch {
    // No remote HEAD configured — fall through
  }

  // 2. Fallback: current branch
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 10_000 },
    );
    const branch = stdout.trim();
    if (branch && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // Detached HEAD or other issue — fall through
  }

  // 3. Final fallback
  return "main";
}
