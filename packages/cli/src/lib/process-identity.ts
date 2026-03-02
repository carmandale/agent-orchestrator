/**
 * Process identity utilities — validate that a PID belongs to an ao process
 * before killing it. Prevents killing unrelated processes on PID recycle.
 */

import { execSilent } from "./shell.js";

/** Patterns that identify ao-managed processes by their command line. */
const AO_COMMAND_PATTERNS = [
  /ao-web/,
  /agent-orchestrator/,
  /terminal-websocket/,
  /direct-terminal-ws/,
  /next dev/,
  /next-server/,
];

/**
 * Check if a PID belongs to an ao-managed process by inspecting its command line.
 * Returns false if the process is dead or its command doesn't match ao patterns.
 */
export async function isAoProcess(pid: number): Promise<boolean> {
  const output = await execSilent("ps", ["-o", "command=", "-p", String(pid)]);
  if (!output) return false;
  const cmd = output.trim();
  if (!cmd) return false;
  return AO_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd));
}

/**
 * Validate that a PID belongs to an ao process AND hasn't been recycled.
 * Combines command-line identity check with PID start-time verification.
 */
export async function validateAoProcessIdentity(
  pid: number,
  expectedStartTime?: string,
): Promise<boolean> {
  // First check: is this an ao process?
  const isAo = await isAoProcess(pid);
  if (!isAo) return false;

  // Second check: has the PID been recycled? (if we have a recorded start time)
  if (expectedStartTime) {
    const currentStartTime = await execSilent("ps", ["-o", "lstart=", "-p", String(pid)]);
    if (!currentStartTime || currentStartTime.trim() !== expectedStartTime) {
      return false;
    }
  }

  return true;
}
