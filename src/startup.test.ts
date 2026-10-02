import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("Ctrl+C during collection exits without ready output and removes temporary HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-cancel-"));
  mkdirSync(join(root, ".ccusage"));
  writeFileSync(join(root, ".ccusage", "ccusage.json"), JSON.stringify({ defaults: { offline: true } }));
  mkdirSync(join(root, "data"));
  const proc = spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "--port", String(await unusedPort())], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: root, CI: "1", SSH_CONNECTION: "synthetic", CLAUDE_CONFIG_DIR: join(root, "data"), CODEX_HOME: join(root, "data"), GEMINI_DATA_DIR: join(root, "data"), OPENCODE_DATA_DIR: join(root, "data") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let cancelled = false;
  const consume = (data: Buffer): void => {
    output += data.toString();
    if (!cancelled && output.includes("Collecting full history")) { cancelled = true; proc.kill("SIGINT"); }
  };
  proc.stdout.on("data", consume);
  proc.stderr.on("data", consume);
  const timer = setTimeout(() => proc.kill("SIGKILL"), 4000);
  try {
    const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
    expect(cancelled).toBe(true);
    expect(code).toBe(130);
    expect(output).toContain("Cancelled");
    expect(output).not.toContain("ccusage ledger:");
    expect(output).not.toContain("Data source:");
    expect(readdirSync(root).filter((name) => name.startsWith("ccusage-home-"))).toEqual([]);
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
