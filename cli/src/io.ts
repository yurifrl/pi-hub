// cli/src/io.ts — process IO for command bodies (docs/03-cli.md §bin: bin.ts
// wires the context; bodies touch the terminal only through this shape, so
// tests can drive prompts and pickers with fake TTYs).

import { createInterface, type Interface } from "node:readline";

export type CommandIo = {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export const processIo = (): CommandIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

/**
 * One line from stdin in canonical mode — the terminal driver handles echo
 * and editing; we only print the prompt and read the result. Resolves ""
 * when the stream closes before a line arrives.
 */
export const readLine = (io: CommandIo, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v: string): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    io.stdout.write(prompt);
    const rl: Interface = createInterface({ input: io.stdin });
    rl.once("line", (line: string) => {
      rl.close();
      done(line);
    });
    rl.once("close", () => done(""));
  });

/**
 * Yes/no consent prompt (docs/03 §Subcommands `kill`): default N — only a
 * literal y/Y line consents; anything else (including empty) declines.
 */
export const confirmLine = async (io: CommandIo, prompt: string): Promise<boolean> => {
  const answer = await readLine(io, prompt);
  return answer.trim().toLowerCase() === "y";
};
