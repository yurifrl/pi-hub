// hub sessions — machine-wide omp session inventory (roster + detached transcripts).

import type { RegisterCommand } from "../context";
import { CliError } from "../errors";
import { emitSnapshot } from "../output";
import { painter } from "../paint";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const register: RegisterCommand = (program, ctx) => {
  program
    .command("sessions")
    .description("list every omp session on this machine")
    .action(async () => {
      let reply: unknown;
      try {
        reply = await ctx.call("sessions", {});
      } catch (e) {
        // spec: a failed scan on the hub is exit 2, not the generic busy (exit 1)
        if (e instanceof CliError && e.code === "busy") throw new CliError("protocol", e.message);
        throw e;
      }
      const body = isObj(reply) ? reply : {};
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      const detached = Array.isArray(body.detached) ? body.detached.map(str) : [];
      const errors = Array.isArray(body.errors) ? body.errors.map(str) : [];
      emitSnapshot(ctx.policy, { sessions, detached, ...(errors.length ? { errors } : {}) });
      if (ctx.policy.machine) return;
      const paint = painter(ctx.policy);
      for (const e of errors) process.stderr.write(`${paint("muted", `warning: ${e}`)}\n`);
      const rows = sessions.filter(isObj).map((r) => [str(r.id), str(r.title), str(r.cwd), str(r.model), str(r.status)]);
      if (rows.length > 0) {
        const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => (r[i] as string).length)));
        for (const r of rows) {
          const cells = r.slice(0, 4).map((c, i) => c.padEnd(widths[i] as number));
          process.stdout.write(`${cells.join(" · ")} · ${paint(r[4] === "detached" ? "muted" : "ok", r[4] as string)}\n`);
        }
      } else if (detached.length === 0) {
        process.stdout.write(`${paint("muted", "no sessions")}\n`);
      }
      if (detached.length > 0) {
        process.stdout.write(`${paint("muted", `detached (quiet): ${detached.join(" ")}`)}\n`);
      }
    });
};
