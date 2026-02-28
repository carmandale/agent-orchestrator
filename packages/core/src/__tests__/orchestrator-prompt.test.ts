/**
 * Unit tests for orchestrator prompt generation.
 */

import { describe, it, expect } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

function makeConfig(): { config: OrchestratorConfig; projectId: string; project: ProjectConfig } {
  const project: ProjectConfig = {
    name: "test-app",
    repo: "org/test-app",
    path: "/repos/test-app",
    defaultBranch: "main",
    sessionPrefix: "ta",
  };

  const config = {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: { "test-app": project },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
  } as OrchestratorConfig;

  return { config, projectId: "test-app", project };
}

describe("generateOrchestratorPrompt — coordinator mode (no prompt)", () => {
  it("generates coordinator prompt with orchestrator header", () => {
    const opts = makeConfig();
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("# test-app Orchestrator");
    expect(result).toContain("orchestrator agent");
  });

  it("includes 'you do NOT write code yourself'", () => {
    const opts = makeConfig();
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("You do NOT write code yourself");
  });

  it("includes project info", () => {
    const opts = makeConfig();
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("org/test-app");
    expect(result).toContain("/repos/test-app");
    expect(result).toContain("main");
  });

  it("includes CLI commands table", () => {
    const opts = makeConfig();
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("ao status");
    expect(result).toContain("ao spawn");
    expect(result).toContain("ao send");
  });

  it("includes session management workflow", () => {
    const opts = makeConfig();
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("Session Management");
    expect(result).toContain("Spawning Sessions");
  });
});

describe("generateOrchestratorPrompt — discover-first mode (with prompt)", () => {
  it("generates discover-first prompt with Build Agent header", () => {
    const opts = { ...makeConfig(), prompt: "Build a todo app with auth" };
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("# test-app — Build Agent");
    expect(result).toContain("You are building test-app");
  });

  it("includes the user's prompt text", () => {
    const prompt = "Build a todo app with auth and a nice dashboard";
    const opts = { ...makeConfig(), prompt };
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain(prompt);
    expect(result).toContain("What the user wants");
  });

  it("includes critical rules", () => {
    const opts = { ...makeConfig(), prompt: "Build something" };
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("Don't over-engineer");
    expect(result).toContain("Match solution weight to problem weight");
    expect(result).toContain("validation harnesses");
  });

  it("includes project info and CLI commands", () => {
    const opts = { ...makeConfig(), prompt: "Build something" };
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("org/test-app");
    expect(result).toContain("/repos/test-app");
    expect(result).toContain("ao status");
    expect(result).toContain("ao spawn");
  });

  it("does NOT say 'you do NOT write code yourself'", () => {
    const opts = { ...makeConfig(), prompt: "Build something" };
    const result = generateOrchestratorPrompt(opts);

    expect(result).not.toContain("You do NOT write code yourself");
  });

  it("includes discover-first approach instructions", () => {
    const opts = { ...makeConfig(), prompt: "Build a thing" };
    const result = generateOrchestratorPrompt(opts);

    expect(result).toContain("Explore the repo");
    expect(result).toContain("start by DOING, not by planning");
  });

  it("includes project-specific rules when present", () => {
    const opts = makeConfig();
    opts.project.orchestratorRules = "Always use TypeScript strict mode";
    const result = generateOrchestratorPrompt({
      ...opts,
      prompt: "Build something",
    });

    expect(result).toContain("Always use TypeScript strict mode");
  });
});
