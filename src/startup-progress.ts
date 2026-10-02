export interface StartupProgressOptions {
  isTTY?: boolean;
  ci?: boolean;
  write?: (text: string) => void;
  /** Monotonic milliseconds, normally performance.now(). */
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Owns only stderr startup display; callers supply observed stages and outcomes. */
export function createStartupProgress(options: StartupProgressOptions = {}) {
  const animated = (options.isTTY ?? process.stderr.isTTY ?? false)
    && !(options.ci ?? Boolean(process.env.CI));
  const write = options.write ?? ((text: string) => { process.stderr.write(text); });
  const now = options.now ?? (() => performance.now());
  const schedule = options.setInterval ?? ((callback: () => void, milliseconds: number) =>
    setInterval(callback, milliseconds));
  const cancel = options.clearInterval ?? ((handle: unknown) =>
    clearInterval(handle as ReturnType<typeof setInterval>));
  const started = now();
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let message: string | undefined;
  let timer: { handle: unknown } | undefined;
  let stopped = false;
  let displayed = false;

  function clearLine() {
    if (displayed) {
      write("\r\x1b[2K");
      displayed = false;
    }
  }

  function render() {
    if (stopped || !animated || message === undefined) {
      return;
    }
    const elapsed = ((now() - started) / 1000).toFixed(1);
    write(`\r\x1b[2K${frames[frame++ % frames.length]} ${message} (${elapsed}s)`);
    displayed = true;
  }

  function dispose() {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      cancel(timer.handle);
      timer = undefined;
    }
    clearLine();
  }

  return {
    stage(nextMessage: string) {
      if (stopped || message === nextMessage) {
        return;
      }
      message = nextMessage;
      if (animated) {
        render();
        if (!timer) {
          timer = { handle: schedule(render, 100) };
        }
      } else {
        write(`${message}\n`);
      }
    },
    warn(warning: string) {
      if (stopped) {
        return;
      }
      clearLine();
      write(`${warning}\n`);
      render();
    },
    finish(outcome: string) {
      if (stopped) {
        return;
      }
      dispose();
      write(`${outcome}\n`);
    },
    dispose,
  };
}
