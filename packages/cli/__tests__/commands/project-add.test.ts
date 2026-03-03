import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "commander";
import { registerProjectAdd } from "../../src/commands/project-add.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Create a directory and `git init` it so A1 validation passes. */
function mkGitDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: dirPath, stdio: "ignore" });
}

/**
 * Helper: create a temp dir with a minimal config file and a fake project path.
 * Returns { configPath, projectPath }.
 */
function setupEnv(extraYaml = ""): { configPath: string; projectPath: string } {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-project-add-test-"));

  const projectPath = join(tmpDir, "my-repo");
  mkGitDir(projectPath);

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  const baseYaml = `# Test config
projects:
  existing:
    repo: org/existing
    path: ${projectPath}
${extraYaml}`;

  writeFileSync(configPath, baseYaml, "utf-8");

  // Point AO_CONFIG_PATH to our test config
  vi.stubEnv("AO_CONFIG_PATH", configPath);

  return { configPath, projectPath };
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerProjectAdd(program);
  return program;
}

describe("ao project add", () => {
  it("adds a project to the YAML file correctly", async () => {
    const { configPath } = setupEnv();
    const newProjectPath = join(tmpDir, "new-app");
    mkGitDir(newProjectPath);

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "new-app",
      "--repo",
      "carmandale/new-app",
      "--path",
      newProjectPath,
    ]);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("new-app:");
    expect(content).toContain("carmandale/new-app");
    expect(content).toContain(newProjectPath);
  });

  it("validates repo format (rejects bad format)", async () => {
    setupEnv();
    const newProjectPath = join(tmpDir, "bad-repo");
    mkdirSync(newProjectPath);

    const program = makeProgram();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "project",
        "add",
        "bad",
        "--repo",
        "not-a-valid-repo",
        "--path",
        newProjectPath,
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("validates path exists (rejects nonexistent)", async () => {
    setupEnv();

    const program = makeProgram();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "project",
        "add",
        "ghost",
        "--repo",
        "org/ghost",
        "--path",
        "/nonexistent/path/that/does/not/exist",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("rejects duplicate project name", async () => {
    setupEnv();

    const program = makeProgram();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    // "existing" is already in the config
    const projectPath = join(tmpDir, "my-repo");

    await expect(
      program.parseAsync([
        "node",
        "test",
        "project",
        "add",
        "existing",
        "--repo",
        "org/existing",
        "--path",
        projectPath,
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("handles optional flags (branch, session-prefix, agent)", async () => {
    const { configPath } = setupEnv();
    const newProjectPath = join(tmpDir, "flagged-app");
    mkGitDir(newProjectPath);

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "flagged",
      "--repo",
      "org/flagged-app",
      "--path",
      newProjectPath,
      "--branch",
      "develop",
      "--session-prefix",
      "flg",
      "--agent",
      "codex",
      "--agent-permissions",
      "skip",
    ]);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("develop");
    expect(content).toContain("flg");
    expect(content).toContain("codex");
    expect(content).toContain("skip");
  });

  it("defaults --path to process.cwd() when not provided", async () => {
    const { configPath } = setupEnv();
    // Temporarily override cwd to our test project path
    const projectPath = join(tmpDir, "cwd-test");
    mkGitDir(projectPath);
    const originalCwd = process.cwd;
    process.cwd = () => projectPath;

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "cwd-test",
      "--repo",
      "org/cwd-test",
      // No --path flag
    ]);

    process.cwd = originalCwd;

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("cwd-test:");
    expect(content).toContain(projectPath);
  });

  it("adds a project without --repo (local-only)", async () => {
    const { configPath } = setupEnv();
    const newProjectPath = join(tmpDir, "local-only");
    mkGitDir(newProjectPath);

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "local-only",
      "--path",
      newProjectPath,
      // No --repo flag and no git remote configured
    ]);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("local-only:");
    expect(content).toContain(newProjectPath);
    // repo should NOT be written to the YAML
    expect(content).not.toMatch(/local-only:[\s\S]*?repo:/);
  });

  it("infers repo from git remote origin", async () => {
    const { configPath } = setupEnv();
    const newProjectPath = join(tmpDir, "inferred-repo");
    mkGitDir(newProjectPath);
    // Configure a remote so `git remote get-url origin` works
    execFileSync("git", ["-C", newProjectPath, "remote", "add", "origin", "https://github.com/alice/inferred-repo.git"]);

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "inferred-repo",
      "--path",
      newProjectPath,
      // No --repo flag — should infer from remote
    ]);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("inferred-repo:");
    expect(content).toContain("alice/inferred-repo");
  });

  it("preserves existing YAML comments", async () => {
    const { configPath } = setupEnv();
    const newProjectPath = join(tmpDir, "comment-test");
    mkGitDir(newProjectPath);

    const program = makeProgram();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "project",
      "add",
      "comment-test",
      "--repo",
      "org/comment-test",
      "--path",
      newProjectPath,
    ]);

    const content = readFileSync(configPath, "utf-8");
    // The "# Test config" comment from setupEnv() should be preserved
    expect(content).toContain("# Test config");
  });
});
