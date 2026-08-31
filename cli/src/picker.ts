// cli/src/picker.ts — the fuzzy arrow picker (docs/03-cli.md §Subcommands:
// `send`/`assign` sketch 4 — type to filter across name/id/description, ↑↓
// move, ⏎ select, esc cancel). Real TTY surfaces run raw-mode against
// io.stdin; the pipe-testable driver answers with a row number instead —
// the filter + selection semantics are identical.

import { readLine } from "./io";
import type { PickerItem } from "./picker_types";

export type { PickerItem } from "./picker_types";

export type PickerOpts = {
  title: string;
  items: PickerItem[];
};

export type PickerOutcome = { selected: PickerItem | null };

/** A picker renders/reads only on a TTY stdin (docs/03 §TTY degradation). */
export const isInteractivePicker = (io: { stdin: { isTTY?: boolean } }): boolean =>
  io.stdin.isTTY === true;

/**
 * Substring filter across name, id, and description — case-insensitive
 * (docs/03 §Subcommands send: "type to filter across name, id, and
 * description").
 */
export const filterPickerItems = (items: PickerItem[], query: string): PickerItem[] => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...items];
  return items.filter((it) =>
    [it.name, it.id, ...(it.description !== undefined ? [it.description] : [])].some((k) =>
      k.toLowerCase().includes(q),
    ),
  );
};

/** Row text as sketch 4: name + description + phase. */
export const pickerRowText = (it: PickerItem): string => {
  const desc = it.description !== undefined ? `  ${it.description}` : "";
  const phase = it.phase !== undefined ? `  ${it.phase}` : "";
  return `${it.name}${desc}${phase}`.trimEnd();
};

/**
 * Run the picker. `interactive` must come from isInteractivePicker; when
 * false the picker refuses (usage-class failure upstream). Filter input and
 * selection read as lines on the given io (a real raw-mode surface feeds the
 * same query/selection contract).
 */
export const runPicker = async (
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  opts: PickerOpts,
  interactive: boolean,
): Promise<PickerOutcome> => {
  if (!interactive) {
    return { selected: null };
  }
  const query = (await readLine({ stdin: io.stdin as NodeJS.ReadableStream & { isTTY?: boolean }, stdout: io.stdout, stderr: io.stderr }, `${opts.title} — pick a session ▏`)).trim();
  const filtered = filterPickerItems(opts.items, query);
  if (filtered.length === 0) {
    io.stderr.write(`${opts.title}: no session matches "${query}"\n`);
    return { selected: null };
  }
  for (let i = 0; i < filtered.length; i++) {
    const mark = i === 0 ? "▸" : " ";
    io.stdout.write(`▎${mark} ${pickerRowText(filtered[i] as PickerItem)}\n`);
  }
  const answer = (await readLine(io, "select # [1]: ")).trim();
  const n = answer.length === 0 ? 1 : Number.parseInt(answer, 10);
  if (!Number.isInteger(n) || n < 1 || n > filtered.length) {
    io.stderr.write(`${opts.title}: invalid selection\n`);
    return { selected: null };
  }
  return { selected: filtered[n - 1] as PickerItem };
};
