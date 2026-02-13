import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@agent-orchestrator/core";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .action(async (opts: { port?: string; open?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : config.port;

      console.log(
        chalk.bold(`Starting dashboard on http://localhost:${port}\n`)
      );

      // The web package handles the actual server.
      // Locate it relative to this package.
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const webDir = resolve(thisDir, "../../web");

      try {
        const child = spawn("npx", ["next", "dev", "-p", String(port)], {
          cwd: webDir,
          stdio: "inherit",
        });

        if (opts.open !== false) {
          setTimeout(() => {
            spawn("open", [`http://localhost:${port}`], {
              stdio: "ignore",
            });
          }, 3000);
        }

        child.on("exit", (code) => {
          process.exit(code ?? 0);
        });
      } catch (err) {
        console.error(
          chalk.red(
            "Could not start dashboard. Ensure @agent-orchestrator/web is installed."
          )
        );
        console.error(chalk.dim(String(err)));
        process.exit(1);
      }
    });
}
