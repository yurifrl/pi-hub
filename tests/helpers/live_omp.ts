// tests/helpers/live_omp.ts — the LIVE harness for tests/live_integration.test.ts:
// drives a real `omp --mode rpc` child with the hub extension loaded (-e), feeds
// prompt frames, and pumps stdout frames the same way the omp host does.
// Hermetic: OMP_HUB_SOCK pins hub.sock under a tmp root; OMP_BIN=/bin/echo keeps
// hub-agent spawns inert; a scratch config.yml disables xdev tools so hub_* mount
// top-level. Skipped entirely when `omp` is not on PATH.
//
// NOTE on scopes: this harness needs child_process + net + fs — imports the test
// file intentionally does not make. That seam is the point: the test stays in
// bun:test's sandbox voice while the real-I/O plumbing lives here.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Json = Record<string, unknown>;

/** One observed frame with its capture time (s since harness start). */
export interface Captured {
    t: number;
    frame: Json;
}

export interface OmpRpc {
    readonly proc: ChildProcessWithoutNullStreams;
    readonly frames: Captured[];
    readonly widgets: Array<{ key: string; lines: string[] | null }>;
    readonly stdoutText: string;
    rpc(prompt: string): void;
    /** Connect a fake peer session over the real hub.sock; returns its send fn. */
    peer(): Promise<(obj: Json) => void>;
    waitForWidget(substr: string, timeoutMs?: number): Promise<boolean>;
    waitFor(pred: () => boolean, label: string, timeoutMs?: number): Promise<void>;
    close(): Promise<void>;
}

export interface LiveHub {
    rpc: OmpRpc;
    /** Absolute path of hub.sock for this run. */
    sockPath: string;
    root: string;
    cleanup(): void;
}

export const ompAvailable = async (): Promise<boolean> => {
    const probe = spawn("omp", ["--version"], { stdio: "ignore" });
    const { promise, resolve } = Promise.withResolvers<boolean>();
    probe.once("error", () => resolve(false));
    probe.once("exit", (code) => resolve(code === 0));
    return promise;
};

/**
 * Spawn the live harness. `root` is a fresh tmp dir; hub.sock, the scratch
 * config, and frames.log live under it. Same shape as the tk-l2e dev probes.
 */
export const spawnLiveHub = (extensionPath: string): LiveHub => {
    const root = mkdtempSync(join(tmpdir(), "omp-hub-live-"));
    const sockPath = join(root, "hub.sock");
    const cfgPath = join(root, "config.yml");
    // Blank-slate overlay matching the dev probes: xdev tools off so hub_* tools
    // mount top-level instead of behind the xdev namespace (probe v6 finding).
    writeFileSync(cfgPath, "tools:\n  xdev: false\n");

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        OMP_HUB_SOCK: sockPath,
        OMP_BIN: "/bin/echo",
        OMP_NO_PROJECT: "1",
    };

    const proc = spawn("omp", ["--mode", "rpc", "--config", cfgPath, "-e", extensionPath], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const frames: Captured[] = [];
    const widgets: OmpRpc["widgets"] = [];
    const t0 = Date.now();
    let stdoutText = "";
    let stderrText = "";

    const record = (frame: Json): void => {
        frames.push({ t: (Date.now() - t0) / 1000, frame });
        if (frame.type === "extension_ui_request" && frame.method === "setWidget") {
            widgets.push({
                key: String(frame.widgetKey ?? ""),
                lines: Array.isArray(frame.widgetLines) ? (frame.widgetLines as string[]).map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, "")) : null,
            });
        }
    };

    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
        stdoutText += chunk;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
                record(JSON.parse(line) as Json);
            } catch {
                /* non-JSON stdout line — ignore */
            }
        }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
    });

    const rpc = (prompt: string): void => {
        proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt, id: `live-${frames.length}` }) + "\n");
    };

    const peer = async (): Promise<(obj: Json) => void> => {
        const { promise: connected, resolve: onConnect, reject: onFail } = Promise.withResolvers<Socket>();
        const s = connect(sockPath);
        s.once("connect", () => onConnect(s));
        s.once("error", onFail);
        const sock: Socket = await connected;

        let pbuf = "";
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => {
            pbuf += chunk;
            let nl: number;
            while ((nl = pbuf.indexOf("\n")) !== -1) {
                const line = pbuf.slice(0, nl);
                pbuf = pbuf.slice(nl + 1);
                try {
                    record({ _peer_rx: JSON.parse(line) as Json });
                } catch {
                    /* ignore */
                }
            }
        });
        return (obj: Json): void => {
            sock.write(JSON.stringify(obj) + "\n");
        };
    };

    const waitFor = (pred: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const deadline = Date.now() + timeoutMs;
        const tick = (): void => {
            if (pred()) return resolve();
            if (Date.now() > deadline) {
                return reject(new Error(`live harness poll timed out: ${label}\nstderr: ${stderrText.slice(-2000)}`));
            }
            setTimeout(tick, 25);
        };
        tick();
        return promise;
    };

    const waitForWidget = (substr: string, timeoutMs = 10_000): Promise<boolean> =>
        waitFor(
            () => widgets.some((w) => w.key === "omp-hub-stream" && (w.lines ?? []).some((l) => l.includes(substr))),
            `widget ${substr}`,
            timeoutMs,
        ).then(() => true);

    const close = async (): Promise<void> => {
        proc.kill();
        const { promise, resolve } = Promise.withResolvers<void>();
        const killTimer = setTimeout(() => {
            proc.kill("SIGKILL");
            resolve();
        }, 3000);
        proc.once("exit", () => {
            clearTimeout(killTimer);
            resolve();
        });
        await promise;
    };

    return {
        proc,
        frames,
        widgets,
        get stdoutText() {
            return stdoutText;
        },
        rpc,
        peer,
        waitForWidget,
        waitFor,
        close,
        sockPath,
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
};
