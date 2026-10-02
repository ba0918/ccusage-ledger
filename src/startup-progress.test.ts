import { describe, expect, test } from "bun:test";
import { createStartupProgress } from "./startup-progress";

function harness(isTTY = true, ci = false) {
  const writes: string[] = [];
  const callbacks = new Map<number, () => void>();
  let clock = 500;
  let nextTimer = 0;
  const progress = createStartupProgress({
    isTTY, ci,
    write: (text) => { writes.push(text); },
    now: () => clock,
    setInterval: (callback) => {
      const id = ++nextTimer;
      callbacks.set(id, callback);
      return id;
    },
    clearInterval: (handle) => { callbacks.delete(handle as number); },
  });
  return {
    progress, writes, callbacks,
    advance(ms: number) { clock += ms; for (const callback of callbacks.values()) { callback(); } },
  };
}

describe("startup progress", () => {
  test("TTY shows the observed stage and monotonic elapsed time on one line", () => {
    const h = harness();
    expect(h.writes).toEqual([]);
    h.progress.stage("Verify ccusage");
    expect(h.writes.at(-1)).toContain("Verify ccusage (0.0s)");
    expect(h.callbacks.size).toBe(1);
    h.advance(1250);
    expect(h.writes.at(-1)).toContain("Verify ccusage (1.3s)");
    h.progress.stage("Collect full history");
    expect(h.writes.at(-1)).toContain("Collect full history (1.3s)");
    expect(h.callbacks.size).toBe(1);
    expect(h.writes.every((line) => line.startsWith("\r\x1b[2K") && !line.includes("\n"))).toBe(true);
    h.progress.dispose();
  });

  for (const [label, isTTY, ci] of [["nonTTY", false, false], ["CI TTY", true, true]] as const) {
    test(`${label} emits stage changes and final lines without animation or timers`, () => {
      const h = harness(isTTY, ci);
      h.progress.stage("Verify ccusage");
      h.progress.stage("Verify ccusage");
      h.advance(5000);
      h.progress.stage("Collect since 2026-09-01");
      h.progress.warn("Cache write failed");
      h.progress.finish("Ready: http://127.0.0.1:3737");
      expect(h.writes).toEqual([
        "Verify ccusage\n", "Collect since 2026-09-01\n",
        "Cache write failed\n", "Ready: http://127.0.0.1:3737\n",
      ]);
      expect(h.callbacks.size).toBe(0);
    });
  }

  test("warning clears the active TTY line and resumes the same stage", () => {
    const h = harness();
    h.progress.stage("Validate/save");
    h.progress.warn("Cache write failed");
    expect(h.writes.slice(-3)).toEqual([
      "\r\x1b[2K", "Cache write failed\n", expect.stringContaining("Validate/save (0.0s)"),
    ]);
    expect(h.callbacks.size).toBe(1);
    h.progress.dispose();
  });

  test("finish prints an ordinary final line and prevents later display activity", () => {
    const h = harness();
    h.progress.stage("Collect full history");
    const lateTick = [...h.callbacks.values()][0]!;
    h.progress.finish("Ready: empty usage");
    expect(h.writes.slice(-2)).toEqual(["\r\x1b[2K", "Ready: empty usage\n"]);
    expect(h.callbacks.size).toBe(0);
    const count = h.writes.length;
    lateTick();
    h.progress.stage("Too late");
    h.progress.warn("Too late");
    h.progress.finish("Too late");
    h.progress.dispose();
    expect(h.writes.length).toBe(count);
  });

  test("dispose cancels display cleanly and is safe before any stage", () => {
    const h = harness();
    h.progress.stage("Collect full history");
    const lateTick = [...h.callbacks.values()][0]!;
    h.progress.dispose();
    expect(h.writes.at(-1)).toBe("\r\x1b[2K");
    expect(h.callbacks.size).toBe(0);
    const count = h.writes.length;
    lateTick();
    h.progress.dispose();
    h.progress.finish("Must not become ready");
    expect(h.writes.length).toBe(count);
    const idle = harness();
    idle.progress.dispose();
    expect(idle.writes).toEqual([]);
  });
});
