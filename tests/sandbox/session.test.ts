import { describe, it, expect, vi } from "vitest";
import {
  RESULT_FILE,
  readResultFile,
  watchDetached,
  runAgent,
  type AgentSandbox,
} from "../../src/sandbox/session.ts";
import type { JarvisEvent } from "../../src/agent/events.ts";
import type { AgentTask } from "../../src/agent/tasks.ts";

const RESULT_EVENT: JarvisEvent = {
  kind: "result",
  subtype: "success",
  text: "done",
  costUsd: 0.1,
  sessionId: "s1",
};

// A programmable fake AgentSandbox. Files are an in-memory map; commands.run
// returns a controllable promise; commands.list returns whatever is set.
function makeFake(opts: {
  files?: Record<string, string>;
  processes?: { cmd: string; args: string[] }[];
  // run() resolves/rejects when the returned controls are used.
} = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  let processes = opts.processes ?? [{ cmd: "node", args: ["/opt/jarvis-agent/runner.mjs"] }];

  let onStdout: ((d: string) => void) | undefined;
  let resolveRun!: (v: { exitCode: number }) => void;
  let rejectRun!: (e: unknown) => void;
  const runPromise = new Promise<{ exitCode: number }>((res, rej) => {
    resolveRun = res;
    rejectRun = rej;
  });

  const sbx: AgentSandbox = {
    files: {
      read: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path)!;
      },
      write: async (path: string, data: string) => {
        files.set(path, data);
      },
    },
    commands: {
      run: async (_cmd: string, o: { onStdout?: (d: string) => void }) => {
        onStdout = o.onStdout;
        return runPromise;
      },
      list: async () => processes,
    },
  };

  return {
    sbx,
    setFile: (path: string, data: string) => files.set(path, data),
    setProcesses: (p: { cmd: string; args: string[] }[]) => {
      processes = p;
    },
    emit: (chunk: string) => onStdout?.(chunk),
    resolveRun,
    rejectRun,
  };
}

describe("readResultFile", () => {
  it("returns the event for a result/error JSON", async () => {
    const f = makeFake({ files: { [RESULT_FILE]: JSON.stringify(RESULT_EVENT) } });
    expect(await readResultFile(f.sbx)).toEqual(RESULT_EVENT);
  });

  it("returns null for non-event JSON (case d)", async () => {
    const f = makeFake({ files: { [RESULT_FILE]: JSON.stringify({ hello: "world" }) } });
    expect(await readResultFile(f.sbx)).toBeNull();
  });

  it("returns null for a non-result kind", async () => {
    const f = makeFake({ files: { [RESULT_FILE]: JSON.stringify({ kind: "assistant_text", text: "hi" }) } });
    expect(await readResultFile(f.sbx)).toBeNull();
  });

  it("returns null for unreadable/missing files (case d)", async () => {
    const f = makeFake({ files: {} });
    expect(await readResultFile(f.sbx)).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const f = makeFake({ files: { [RESULT_FILE]: "{not json" } });
    expect(await readResultFile(f.sbx)).toBeNull();
  });
});

describe("watchDetached", () => {
  it("returns the file result once it appears", async () => {
    const f = makeFake({ files: {} });
    const p = watchDetached(f.sbx, { pollMs: 10, deadlineMs: 5_000 });
    f.setFile(RESULT_FILE, JSON.stringify(RESULT_EVENT));
    expect(await p).toEqual(RESULT_EVENT);
  });

  it("does a final read when the runner is gone, then returns it (case b)", async () => {
    const f = makeFake({ files: {}, processes: [] });
    // runner absent from process list; file present -> returned promptly
    f.setFile(RESULT_FILE, JSON.stringify(RESULT_EVENT));
    const r = await watchDetached(f.sbx, { pollMs: 10, deadlineMs: 5_000 });
    expect(r).toEqual(RESULT_EVENT);
  });

  it("returns null when runner is gone and no file ever appears", async () => {
    const f = makeFake({ files: {}, processes: [] });
    expect(await watchDetached(f.sbx, { pollMs: 10, deadlineMs: 5_000 })).toBeNull();
  });

  it("returns null when the deadline is exceeded (case c)", async () => {
    const f = makeFake({ files: {} }); // runner still present, no file
    const r = await watchDetached(f.sbx, { pollMs: 10, deadlineMs: 25 });
    expect(r).toBeNull();
  });

  it("resolves null promptly on abort (no stray timers)", async () => {
    const f = makeFake({ files: {} });
    const ac = new AbortController();
    const p = watchDetached(f.sbx, { pollMs: 10, deadlineMs: 60_000, signal: ac.signal });
    ac.abort();
    expect(await p).toBeNull();
  });

  it("tolerates 3 consecutive transient errors then returns null", async () => {
    let calls = 0;
    const sbx: AgentSandbox = {
      files: {
        read: async () => {
          throw new Error("ENOENT");
        },
        write: async () => {},
      },
      commands: {
        run: async () => ({ exitCode: 0 }),
        list: async () => {
          calls++;
          throw new Error("transient network");
        },
      },
    };
    const r = await watchDetached(sbx, { pollMs: 10, deadlineMs: 60_000 });
    expect(r).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

const TASK = { kind: "plan" } as unknown as AgentTask;

// Yield to the microtask queue so runAgent reaches `commands.run` (which is
// awaited after files.write) and registers its onStdout callback.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("runAgent supervision", () => {
  it("(a) stream delivers result -> returned, watcher aborted", async () => {
    const f = makeFake({ files: {} });
    const events: JarvisEvent[] = [];
    const p = runAgent(f.sbx as never, "key", TASK, (e) => {
      events.push(e);
    });
    await tick(); // let runAgent register onStdout
    f.emit(JSON.stringify(RESULT_EVENT) + "\n");
    f.resolveRun({ exitCode: 0 });
    const out = await p;
    expect(out.result).toEqual(RESULT_EVENT);
    expect(out.exitCode).toBe(0);
    expect(events).toContainEqual(RESULT_EVENT);
  });

  it("(b) stream never settles, process list empty, file present -> file result", async () => {
    const f = makeFake({ files: {}, processes: [] });
    // Simulate the runner writing its result as soon as it's launched (i.e.
    // after runAgent's own RESULT_FILE-clearing write), so the watcher's
    // first read (no sleep needed) picks it up.
    const origRun = f.sbx.commands.run.bind(f.sbx.commands);
    f.sbx.commands.run = async (cmd: string, o: { onStdout?: (d: string) => void }) => {
      f.setFile(RESULT_FILE, JSON.stringify(RESULT_EVENT));
      return origRun(cmd, o);
    };
    const out = await runAgent(f.sbx as never, "key", TASK, () => {});
    expect(out.result).toEqual(RESULT_EVENT);
    expect(out.exitCode).toBe(-1); // stream never finished
    f.resolveRun({ exitCode: 0 }); // late settle must not throw unhandled
  });

  it("(c) stream never settles, file never appears -> null (runner gone + grace)", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFake({ files: {}, processes: [] }); // runner gone, no file
      const p = runAgent(f.sbx as never, "key", TASK, () => {});
      // advance past the grace-wait sleep (production pollMs=30s)
      await vi.advanceTimersByTimeAsync(60_000);
      const out = await p;
      expect(out.result).toBeNull();
      expect(out.exitCode).toBe(-1);
      f.resolveRun({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a stale RESULT_FILE from a prior run before launching the runner (shared-sandbox reuse)", async () => {
    const STALE_EVENT: JarvisEvent = {
      kind: "result",
      subtype: "success",
      text: "stale-from-prior-run",
      costUsd: 0.01,
      sessionId: "prior",
    };
    const f = makeFake({ files: { [RESULT_FILE]: JSON.stringify(STALE_EVENT) } });
    let resultFileAtRunTime: string | undefined;
    const origRun = f.sbx.commands.run.bind(f.sbx.commands);
    f.sbx.commands.run = async (cmd: string, o: { onStdout?: (d: string) => void }) => {
      resultFileAtRunTime = await f.sbx.files.read(RESULT_FILE).catch(() => undefined);
      return origRun(cmd, o);
    };

    const p = runAgent(f.sbx as never, "key", TASK, () => {});
    await tick();
    f.emit(JSON.stringify(RESULT_EVENT) + "\n");
    f.resolveRun({ exitCode: 0 });
    const out = await p;

    expect(resultFileAtRunTime).toBe(""); // cleared before the runner was launched
    expect(out.result).toEqual(RESULT_EVENT); // not the stale prior-run result
  });

  it("stream settles with exit but file has result -> file result used", async () => {
    const f = makeFake({ files: {} });
    const p = runAgent(f.sbx as never, "key", TASK, () => {});
    await tick(); // let runAgent clear RESULT_FILE and register onStdout
    // simulate the runner writing its result to the file during the run
    f.setFile(RESULT_FILE, JSON.stringify(RESULT_EVENT));
    // stream finishes with a nonzero exit and no result event on stdout
    f.resolveRun({ exitCode: 3 });
    const out = await p;
    // stream produced no result event, so readResultFile supplies it
    expect(out.result).toEqual(RESULT_EVENT);
    expect(out.exitCode).toBe(3);
  });
});
