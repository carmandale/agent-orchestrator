/**
 * ProcessManager — utilities for process lifecycle management.
 *
 * Provides reusable port-based process discovery and killing,
 * extracted from DashboardManager for general use.
 */

import { exec } from "../lib/shell.js";

export class ProcessManager {
  /**
   * Find PIDs listening on the given ports and kill them.
   * Best effort — ignores errors for ports not in use or already exited.
   * Returns the list of unique PIDs that were targeted.
   */
  async killByPorts(ports: number[]): Promise<string[]> {
    const allPids: string[] = [];

    for (const port of ports) {
      try {
        const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
        const pids = stdout
          .trim()
          .split("\n")
          .filter((pid) => pid.length > 0);
        allPids.push(...pids);
      } catch {
        // Port not in use
      }
    }

    if (allPids.length === 0) return [];

    const uniquePids = [...new Set(allPids)];

    try {
      await exec("kill", uniquePids);
    } catch {
      // Some processes may have already exited
    }

    return uniquePids;
  }

  /**
   * Check if any process is listening on a port.
   */
  async isPortInUse(port: number): Promise<boolean> {
    try {
      const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}
