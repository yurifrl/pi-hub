// cli/src/pick_session.ts — session targeting shared by assign/send/kill/tool
// (docs/03-cli.md §Subcommands): given-id prefixes resolve client-side against
// the list snapshot; pickers need a TTY (docs/03: machine modes never prompt).

import { resolvePrefix } from "./resolve";
import { failWith, type FailCtx } from "./cmd_mutation_helpers";
import type { PickerItem } from "./picker_types";

export type SessionLike = PickerItem & { title?: string };

/** Resolvable keys for one session: id + name + description/title text. */
export const sessionResolvable = (s: SessionLike): { id: string; keys: string[] } => ({
  id: s.id,
  keys: [s.name, ...(s.description !== undefined ? [s.description] : []), ...(s.title !== undefined ? [s.title] : [])],
});

/**
 * Resolve a given `<id>` prefix across candidates. Failure → the standard
 * envelope/stderr channel and a thrown CliError (never returns on failure).
 */
export const resolveSessionArg = (ctx: FailCtx, candidates: SessionLike[], prefix: string): string => {
  const hit = resolvePrefix(candidates.map(sessionResolvable), prefix);
  if (hit.ok) return hit.id;
  if (hit.envelope.type !== "error") return failWith(ctx, "usage", "session resolution failed");
  return failWith(ctx, hit.envelope.error.code, hit.envelope.error.message, hit.envelope.error.detail);
};

/**
 * Interactive picker over `candidates`. Non-TTY → usage exit 1 (docs/03:
 * pickers require a TTY on stdin; machine modes never prompt). Cancel/no
 * match → usage exit 1. Returns the chosen session id.
 */
export const pickSessionInteractive = async (
  ctx: FailCtx & { io: { stdin: { isTTY?: boolean }; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } },
  candidates: SessionLike[],
  purpose: string,
): Promise<string> => {
  const { runPicker, isInteractivePicker } = await import("./picker");
  if (!isInteractivePicker(ctx.io)) {
    return failWith(ctx, "usage", `${purpose}: a picker needs an interactive terminal (pass an id)`);
  }
  const outcome = await runPicker(
    { stdin: ctx.io.stdin as NodeJS.ReadableStream, stdout: ctx.io.stdout, stderr: ctx.io.stderr },
    { title: `hub ${purpose}`, items: candidates },
    true,
  );
  if (outcome.selected === null) {
    return failWith(ctx, "usage", `${purpose}: no session selected`);
  }
  return outcome.selected.id;
};
