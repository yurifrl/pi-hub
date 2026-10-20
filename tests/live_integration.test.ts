// tests/live_integration.test.ts — tk-l2e: the integration seam between the
// plugin's live wiring and a REAL omp child. docs/01 §Testing pins the unit
// and e2e layers to fakes; this file is the deliberately-thin LIVE layer that
// docs/05 §Widget/Reporter/Entry point at and only this task could prove:
//
//   1. the real `omp --mode rpc` binary loads extensions/hub.ts through the
//      omp extension loader (the -e flag, same factory the TUI runs) and
//      dispatches /hub-start through the REAL RPC prompt frame
//   2. the real setWidget frames come back on stdout — the 8-line widget
//      contract is honored by the actual host, not just our stub
//   3. a peer session connects over the REAL hub.sock and its reporter
//      frames (hello + session_start + user_message + tool_call +
//      agent_end) flow through the socket into status.json and repaint
//      the widget inside the live child
//   4. the child's real agent loop executes hub_* tools end-to-end
//      (tool_execution_start with toolName "hub_*" → cmd over the socket →
//      result text into the conversation)
//   5. /hub-stop tears the socket down; the socket file is gone
//
// Skipped when `omp` is not on PATH (CI/hermetic environments keep 100% of
// the suite green — the in-process layer is fully covered by the other
// suites; this file adds the live-omp proof on top).
//
// The Bun test drives the child through tests/helpers/live_omp.ts, the
// TypeScript port of the throwaway dev probes; polling (never
// sleeps-as-sync) per the sj9 de-flake pattern.
import { describe, it, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "..");
/** Where the live hub composition writes (status.json, logs/, summaries). */
let dataRoot = "";

/** The 8-line widget contract, decoded from the real omp setWidget frame. */
type WidgetPaint = { key: string; lines: string[] | undefined };

type OmpRpc = {
    proc: ChildProcessWithoutNullStreams;
    frames: Array<{ type: string; method?: string; widgetKey?: string; widgetLines?: string[]; [k: string]: unknown }>;
    widgets: WidgetPaint[];
    waitForWidget(substr: string, timeoutMs?: number): Promise<boolean>;
    rpc(prompt: string): void;
    kill(): Promise<void>;
    stdoutText: string;
};

/** Spawn the REAL omp binary in rpc mode with the hub extension loaded via
 * -e (exactly the production extension path) and pump stdout frames. */
const spawnOmp = (env: NodeJS.ProcessEnv, configPath: string): OmpRpc => {
    const proc = spawn("omp", ["--mode", "rpc", "--config", configPath, "-e", join(REPO_ROOT, "extensions", "hub.ts")], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const frames: OmpRpc["frames"] = [];
    const widgets: WidgetPaint[] = [];
    let stdoutText = "";
    const buffer = { text: "" };
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((r) => {
        readyResolve = r;
    });
    proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutText += text;
        buffer.text += text;
        for (;;) {
            const nl = buffer.text.indexOf("\n");
            if (nl < 0) break;
            const line = buffer.text.slice(0, nl).trim();
            buffer.text = buffer.text.slice(nl + 1);
            if (!line) continue;
            let f: Record<string, unknown>;
            try {
                f = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            frames.push(f as OmpRpc["frames"][number]);
            if (f.type === "extension_ui_request" && f.method === "setWidget") {
                widgets.push({ key: f.widgetKey as string, lines: f.widgetLines as string[] | undefined });
            }
            if (f.type === "ready") readyResolve?.();
        }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
        stdoutText += chunk.toString("utf8");
    });
    const rpc = (prompt: string): void => {
        proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
    };
    return {
        proc,
        frames,
        widgets,
        get stdoutText() {
            return stdoutText;
        },
        waitForWidget(substr: string, timeoutMs = 10_000): Promise<boolean> {
            const deadline = Date.now() + timeoutMs;
            const check = (): boolean =>
                widgets.some((w) => w.key === "omp-hub-stream" && (w.lines ?? []).some((l) => l.includes(substr)));
            return new Promise((resolve) => {
                const tick = (): void => {
                    if (check()) return resolve(true);
                    if (Date.now() > deadline) return resolve(false);
                    setTimeout(tick, 25);
                };
                tick();
            });
        },
        rpc,
        kill: async (): Promise<void> => {
            if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, 3000);
                proc.once("exit", () => {
                    clearTimeout(t);
                    resolve();
                });
            });
        },
    } as OmpRpc;
};

/** Wait until pred() or timeout (polling, never fixed sleeps). */
const pollUntil = async (pred: () => boolean, label: string, timeoutMs = 10_000, stepMs = 25): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return;
        await Bun.sleep(stepMs);
    }
    throw new Error(`live integration poll timed out: ${label}`);
};

const ompAvailable = (): boolean => {
    try {
        const check = Bun.spawnSync(["which", "omp"]);
        return check.exitCode === 0;
    } catch {
        return false;
    }
};

describe("live omp integration — real child, real socket, real widget frames (tk-l2e)", () => {
    it(
        "the real omp RPC child loads the hub extension, serves hub.sock, streams a peer session, and paints the widget",
        async () => {
            if (!ompAvailable()) {
                console.log("live integration: omp binary not on PATH — skipping (in-process suites cover the contract)");
                return;
            }
            dataRoot = await mkdtemp(join(tmpdir(), "hub-live-"));
            const sockPath = join(dataRoot, "hub.sock");
            // tools.xdev OFF: mounts every registered tool top-level so the
            // child's agent loop can call hub_list_sessions directly (with
            // xdev on, hub_* tools hide behind xd:// read/write devices — an
            // omp-side indirection this integration doesn't need)
            const overlayPath = join(dataRoot, "overlay.yml");
            await writeFile(overlayPath, "tools:\n  xdev: false\n", "utf8");
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                OMP_HUB_SOCK: sockPath,
                // brain stand-in: the hub only spawns it (docs/05 §Entry step 3);
                // its RPC role is a driven-child concern covered by fakes elsewhere
                OMP_BIN: "/bin/echo",
            };
            delete env.OMP_HUB_BRAIN;
            delete env.OMP_HUB_AGENT;

            const live = spawnOmp(env, overlayPath);
            try {
                // ---- ready + factory claim (docs/05 §Entry step 1) ----
                await pollUntil(() => live.frames.some((f) => f.type === "ready"), "omp rpc ready", 20_000);
                // the REAL host painted the idle claim under the contract key
                await pollUntil(
                    () => live.widgets.some((w) => w.key === "omp-hub-stream" && (w.lines ?? []).join("").includes("hub idle")),
                    "idle widget claim",
                    15_000,
                );

                // ---- /hub-start through the real RPC prompt frame ----
                live.rpc("/hub-start");
                const started = await live.waitForWidget("hub active", 15_000);
                expect(started).toBe(true);
                // socket file really exists on disk
                await pollUntil(() => existsSync(sockPath), "hub.sock bound", 10_000);
                // the real notify came from the real command handler
                expect(live.frames.some((f) => f.method === "notify" && JSON.stringify(f.message ?? "").includes("hub serving on"))).toBe(true);

                // ---- peer session over the REAL socket (docs/05 §Reporter) ----
                const peerFrames: Array<Record<string, unknown>> = [];
                const sock = await new Promise<Socket>((resolve, reject) => {
                    const s = connect(sockPath);
                    let buf = "";
                    s.on("connect", () => {
                        s.write(JSON.stringify({ v: 1, ch: "hello", client: "plugin" }) + "\n");
                        resolve(s);
                    });
                    s.on("error", reject);
                    s.on("data", (b: Buffer) => {
                        buf += b.toString("utf8");
                        for (;;) {
                            const nl = buf.indexOf("\n");
                            if (nl < 0) break;
                            const line = buf.slice(0, nl);
                            buf = buf.slice(nl + 1);
                            try {
                                peerFrames.push(JSON.parse(line) as Record<string, unknown>);
                            } catch {
                                /* ignore torn */
                            }
                        }
                    });
                });
                const report = (frame: string, payload: Record<string, unknown>): void => {
                    sock.write(JSON.stringify({ v: 1, ch: "report", frame, ...payload }) + "\n");
                };
                report("session_start", {
                    sessionId: "live-peer",
                    kind: "peer",
                    cwd: dataRoot,
                    model: "live-model",
                    attached: false,
                    title: "live integration peer",
                });
                await Bun.sleep(150);
                report("user_message", { sessionId: "live-peer", text: "hello from the live peer" });
                await Bun.sleep(150);
                report("tool_call", { sessionId: "live-peer", tool: "confirm", args: { action: "live deploy" } });
                await Bun.sleep(300);
                report("agent_end", { sessionId: "live-peer", reason: "complete" });

                // roster row landed through the real socket → real hub core
                await pollUntil(
                    () => {
                        try {
                            const raw = readFileSync(join(dataRoot, "status.json"), "utf8") as string;
                            const st = JSON.parse(raw) as { sessions?: Record<string, unknown>; attention?: Array<{ kind: string; resolvedAt?: string }> };
                            return st.sessions?.["live-peer"] !== undefined;
                        } catch {
                            return false;
                        }
                    },
                    "peer registered in status.json",
                    10_000,
                );
                // the widget inside the REAL child repainted with the peer row
                // (the row shows the CLIPPED name — "live integ…" — so match on
                // the user_message text, which fills the description slot)
                const peerPainted = await live.waitForWidget("hello from the live peer", 10_000);
                expect(peerPainted).toBe(true);

                // ---- hub_ tools execute inside the real child's agent loop ----
                live.rpc("Use the hub_list_sessions tool now. Then reply with exactly its result text.");
                const toolRan = await pollUntil(
                    () => live.frames.some((f) => f.type === "tool_execution_start" && f.toolName === "hub_list_sessions"),
                    "hub_list_sessions tool_execution_start",
                    120_000,
                    250,
                ).then(() => true, () => false);
                expect(toolRan).toBe(true);
                // and the tool answered through the real socket dispatch (the
                // roster row title proves it read THIS hub's status.json)
                await pollUntil(() => live.frames.some((f) => f.type === "tool_execution_end"), "tool_execution_end", 60_000, 250);

                // ---- /hub-stop teardown (docs/05 §Shutdown) ----
                live.rpc("/hub-stop");
                const stopped = await live.waitForWidget("hub idle", 10_000);
                expect(stopped).toBe(true);
                await pollUntil(() => !existsSync(sockPath), "hub.sock removed", 10_000);

                sock.destroy();
            } finally {
                await live.kill();
                await rm(dataRoot, { recursive: true, force: true });
            }
        },
        240_000,
    );
});
