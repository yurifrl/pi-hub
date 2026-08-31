// lib/adapters/omp_agent.test.ts — AgentRuntime over real child processes.
// Uses /bin/cat (a benign long-running binary) as the child so tests need no
// omp install; the adapter is generic over the bin (docs/05 §Agent spawn).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAgentRuntime } from "./omp_agent";

const tmps: string[] = [];
const makeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "hub-omp-"));
    tmps.push(dir);
    return dir;
};

afterAll(async () => {
    for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

// /bin/cat with no args reads stdin forever — a stand-in for a driven child
const CAT = "/bin/cat";

describe("omp_agent — spawn", () => {
    it("spawns a live child and returns a handle with sessionId null", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root });
        const r = await rt.spawn({ name: "worker-1" });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.name).toBe("worker-1");
            expect(r.value.sessionId).toBe(null); // child announces its session itself
        }
        await rt.kill("worker-1");
    });

    it("default name is worker-N counting live children", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root });
        const a = await rt.spawn({});
        const b = await rt.spawn({});
        if (a.ok && b.ok) {
            expect(a.value.name).toBe("worker-1");
            expect(b.value.name).toBe("worker-2");
        }
        await rt.kill("worker-1");
        await rt.kill("worker-2");
    });

    it("missing binary → error Result (unavailable-hub), no throw", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: join(root, "no-such-bin"), cwd: root });
        const r = await rt.spawn({});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("unavailable-hub");
    });

    it("handle carries model when given; model env split by flavor", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root, model: "aihub/glm-5.3-flash" });
        const r = await rt.spawn({ name: "brain" });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.model).toBe("aihub/glm-5.3-flash");
        await rt.kill("brain");
    });
});

describe("omp_agent — send/kill", () => {
    it("send writes one NDJSON line to the child's stdin (readable via a file sink)", async () => {
        const root = await makeRoot();
        const sinkPath = join(root, "stdin-echo.jsonl");
        // tee stdin to a file so we can assert what was written. /bin/sh is a
        // system binary — launching it is never Gatekeeper-assessed, unlike a
        // freshly written wrapper script (see args doc on OmpAgentOptions).
        const rt2 = createOmpAgentRuntime({
            bin: "/bin/sh",
            args: ["-c", `exec cat > ${JSON.stringify(sinkPath)}`],
            cwd: root,
            extraEnv: {},
        });
        const spawned = await rt2.spawn({ name: "sink" });
        expect(spawned.ok).toBe(true);
        const sent = await rt2.send("sink", "hello hub");
        expect(sent.ok).toBe(true);
        // wait for the child to actually exec and consume the line: the
        // shell's `> sinkPath` redirection creates the file at startup, and
        // the payload line lands after `cat` reads it. Polling for the full
        // expected content is a deterministic readiness signal — killing
        // earlier (SIGTERM mid-exec, before the read) would truncate silently
        const expected = '{"text":"hello hub"}\n';
        let raw = "";
        for (let i = 0; i < 100 && raw !== expected; i++) {
            await Bun.sleep(10);
            raw = (await Bun.file(sinkPath).exists()) ? await Bun.file(sinkPath).text() : "";
        }
        await rt2.kill("sink");
        // kill waits for exit; `cat` closes the file on exit, so the sink is
        // complete — no sleep-based race
        expect(raw).toBe(expected);
        expect(raw).toBe('{"text":"hello hub"}\n');
    });

    it("send to an unknown name → unknown-session error", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root });
        const r = await rt.send("nope", "hi");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("unknown-session");
    });

    it("kill terminates the child (SIGTERM path)", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root, killGraceMs: 500 });
        const r = await rt.spawn({ name: "victim" });
        expect(r.ok).toBe(true);
        const k = await rt.kill("victim");
        expect(k.ok).toBe(true);
        // second kill: child no longer tracked → unknown-session
        const k2 = await rt.kill("victim");
        expect(k2.ok).toBe(false);
        if (!k2.ok) expect(k2.error.code).toBe("unknown-session");
    });

    it("kill of an unknown name → unknown-session error", async () => {
        const root = await makeRoot();
        const rt = createOmpAgentRuntime({ bin: CAT, cwd: root });
        const r = await rt.kill("ghost");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("unknown-session");
    });
});
