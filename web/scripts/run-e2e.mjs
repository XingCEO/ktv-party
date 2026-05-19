import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";

async function isServerUp() {
  try {
    const response = await fetch(baseURL, { method: "HEAD" });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(server) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    if (server.exitCode !== null) {
      throw new Error(`Next dev server exited early with code ${server.exitCode}`);
    }
    if (await isServerUp()) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${baseURL}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;

  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), delay(2_000)]).catch(() => {});

  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(2_000)]).catch(() => {});
  }
}

let server = null;

try {
  if (!(await isServerUp())) {
    server = spawn(
      process.execPath,
      ["./node_modules/next/dist/bin/next", "dev", "-p", "3000", "-H", "127.0.0.1"],
      {
        cwd: webRoot,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    server.stdout.on("data", (chunk) => process.stdout.write(`[Next] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[Next] ${chunk}`));

    await waitForServer(server);
  }

  const playwright = spawn(
    process.execPath,
    ["./node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
    {
      cwd: webRoot,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: baseURL },
      stdio: "inherit",
    },
  );

  const [code] = await once(playwright, "exit");
  await stopServer(server);
  process.exit(code ?? 1);
} catch (error) {
  await stopServer(server);
  console.error(error);
  process.exit(1);
}
