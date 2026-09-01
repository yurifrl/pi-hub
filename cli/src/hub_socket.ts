// cli/src/hub_socket.ts — one-shot cmd/reply client for hub.sock
// (docs/03-cli.md §bin boot sequence; frame shapes owned by docs/02-data-contracts.md §hub.sock).
// One connection per invocation: connect → hello handshake → cmd frame →
// await the reply carrying the matching cmdId up to the deadline → close.
// Subscribe-style event frames are ignored by one-shot clients.

import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { HubError } from "@yurifrl/hub";
import { hubError } from "@yurifrl/hub";

export const PROTOCOL_VERSION = 1 as const;

/** The wire frame written to the socket: `{ v, ch:"cmd", cmdId, op, args, by? }`
 * — `by` optional caller class (docs/02 §cmd frames), default cli. */
export type CmdFrame = {
  v: number;
  ch: "cmd";
  cmdId: string;
  op: string;
  args: Record<string, unknown>;
  by?: string;
};

/** Hub hello reply: `{ v, ch:"hello", hub: { version, startedAt } }`. */
export type HelloReply = {
  v: number;
  ch: "hello";
  hub: { version: number; startedAt: string };
};

/** `{ v, ch:"reply", cmdId, ok:true, result }` or `{ ok:false, error:{ code, message } }`. */
export type ReplyFrame =
  | { v: number; ch: "reply"; cmdId: string; ok: true; result: unknown }
  | { v: number; ch: "reply"; cmdId: string; ok: false; error: { code: string; message: string } };

/** Hub-side error frame: `{ v, ch:"error", error: { code, message } }`. */
export type ErrorFrame = {
  v: number;
  ch: "error";
  error: { code: string; message: string };
};

/**
 * Wire failure → domain error (docs/02 §Error frames and concurrency codes →
 * docs/01 §Error model HubCode). Closed mapping over the wire's code set.
 */
export const wireError = (code: string, message: string): HubError => {
  switch (code) {
    case "timeout":
      return hubError("timeout", message || "hub op deadline exceeded");
    case "no-session":
      return hubError("unknown-session", message || "unknown session");
    case "bad-version":
      return hubError("unavailable-hub", message || "hub protocol version mismatch");
    case "bad-frame":
    case "unknown-op":
    case "forbidden":
    case "busy":
    default:
      // busy renders as a reply error envelope in the caller (exit 1 class)
      return hubError("denied", message || `hub refused the command (${code || "bad-frame"})`);
  }
};

const newCmdId = (): string => `cli-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Send one cmd and await its correlated reply. Returns the reply result or a
 * HubError — never throws. Failure classes:
 * - socket missing / refused / connect error → unavailable-hub (exit 2)
 * - hello version mismatch / malformed frame / cmdId mismatch → unavailable-hub with protocol message (exit 2)
 * - deadline before the matching reply → timeout (exit 3)
 * - hub error frame or ok:false reply → mapped HubError (busy → exit 1 via envelope)
 */
export const hubCmd = async (
  sockPath: string,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  by?: "cli" | "web" | "plugin" | "agent",
): Promise<{ result: unknown } | { error: HubError }> => {
  const myCmdId = newCmdId();
  return await new Promise<{ result: unknown } | { error: HubError }>((resolve) => {
    const socket: Socket = connect(sockPath);
    let buffer = "";
    let helloDone = false;
    let settled = false;

    const finish = (outcome: { result: unknown } | { error: HubError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const fail = (e: HubError) => finish({ error: e });

    const timer = setTimeout(() => {
      fail(hubError("timeout", `no reply within ${timeoutMs}ms (op ${op})`));
    }, timeoutMs);

    // ---- connect ----
    // First frame from any client is hello (docs/02 §Handshake).
    socket.once("connect", () => {
      // hello identity: docs/02 §Handshake client ids; `by` param lets a host
      // (web composition) claim its own caller class so the hub's attention
      // resolution attributes the reply envelope correctly
      send({ v: PROTOCOL_VERSION, ch: "hello", client: by ?? "cli", subscribe: false });
    });
    // connect(path) already starts connecting; attaching the error handler
    // before any await keeps the failure synchronous to this closure.
    socket.once("error", (err: Error) => {
      fail(hubError("unavailable-hub", `cannot connect to hub socket at ${sockPath}: ${err.message}`));
    });

    // ---- framing ----
    const send = (frame: unknown) => socket.write(JSON.stringify(frame) + "\n");

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          fail(hubError("unavailable-hub", `malformed frame from hub: ${line.slice(0, 120)}`));
          return;
        }
        const f = frame as Record<string, unknown>;

        if (!helloDone) {
          if (f.ch === "hello") {
            const hub = f.hub as { version?: number } | undefined;
            if (hub?.version !== PROTOCOL_VERSION) {
              fail(hubError("unavailable-hub", `hub protocol version mismatch (hub v${String(hub?.version)}, client v${PROTOCOL_VERSION})`));
              return;
            }
            helloDone = true;
            send({ v: PROTOCOL_VERSION, ch: "cmd", cmdId: myCmdId, op, args, ...(by !== undefined && by !== "cli" ? { by } : {}) } satisfies CmdFrame);
            continue;
          }
          if (f.ch === "error") {
            const err = f.error as { code?: string; message?: string } | undefined;
            // bad-version arrives as an error frame on handshake mismatch
            fail(wireError(err?.code ?? "bad-frame", err?.message ?? "hub handshake failed"));
            return;
          }
          fail(hubError("unavailable-hub", `unexpected frame before handshake: ch=${String(f.ch)}`));
          return;
        }

        // post-handshake frames
        if (f.ch === "error") {
          const err = f.error as { code?: string; message?: string } | undefined;
          fail(wireError(err?.code ?? "bad-frame", err?.message ?? "hub protocol error"));
          return;
        }
        if (f.ch === "reply" && typeof f.cmdId === "string") {
          const reply = frame as ReplyFrame;
          if (reply.cmdId !== myCmdId) {
            fail(hubError("unavailable-hub", `reply cmdId mismatch: expected ${myCmdId}, got ${reply.cmdId}`));
            return;
          }
          if (reply.ok) finish({ result: reply.result });
          else fail(wireError(reply.error.code, reply.error.message));
          return;
        }
        // ch:"event" and anything unsolicited: one-shot clients ignore
      }
    });

    socket.on("error", (err: Error) => {
      // post-connect socket failure
      fail(hubError("unavailable-hub", `hub socket error: ${err.message}`));
    });
  });
};
