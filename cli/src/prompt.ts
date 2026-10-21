// cli/src/prompt.ts — one-line interactive reads for human mode (stderr prompt, stdin answer).

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CliError } from "./errors";

export type PromptIo = { input?: Readable; output?: Writable };

/** Print `prompt` to stderr and read one line; null on EOF. */
export const askLine = async (prompt: string, io: PromptIo = {}): Promise<string | null> => {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: false });
  output.write(prompt);
  return new Promise<string | null>((resolve) => {
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!done) resolve(null);
    });
  });
};

/** `[y/N]` confirm: only y/Y consents. */
export const confirm = async (prompt: string, io: PromptIo = {}): Promise<boolean> => {
  const line = await askLine(prompt, io);
  return line !== null && /^y$/i.test(line.trim());
};

/** Interactive = a person can answer: TTY on both ends and not a machine mode. */
export const isInteractive = (machine: boolean): boolean =>
  !machine && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

export const requireInteractive = (machine: boolean, what: string): void => {
  if (!isInteractive(machine)) throw new CliError("usage", `${what} needs a terminal; pass it as an argument`);
};
