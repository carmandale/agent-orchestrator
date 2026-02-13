import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

export async function execSilent(
  cmd: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout;
  } catch {
    return null;
  }
}

export async function tmux(...args: string[]): Promise<string | null> {
  return execSilent("tmux", args);
}

export async function git(
  args: string[],
  cwd?: string
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

export async function gh(args: string[]): Promise<string | null> {
  return execSilent("gh", args);
}
