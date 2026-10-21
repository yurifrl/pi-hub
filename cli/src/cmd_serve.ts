// cli/src/cmd_serve.ts — `hub serve` (docs/03 §Subcommands serve): standalone
// hub composition entry (docs/07 §Run). The one sanctioned cli→root edge
// (recorded exception, docs/01 §Import matrix): the CLI already hosts the web
// console and the serve stack lives in the root package — a middle package
// would re-branch cmd_web's precedent. Reads process.env at this boundary;
// the lib side never does.
//
// Not a normal client command: it hosts the socket instead of connecting to
// it. Machine modes are rejected (a server has no snapshot semantics —
// cmd_web precedent); a live hub on the same socket is refused (a second
// server would unlink the live socket file on listen — adapters/unix_socket).
import { serveHub } from "../../extensions/serve";
import type { CommandContext } from "./commands";
import { failWith } from "./cmd_mutation_helpers";

export const cmdServe = async (ctx: CommandContext): Promise<void> => {
  if (ctx.policy.format !== "human") {
    return failWith(ctx, "usage", "serve: a server has no snapshot semantics; run without --json/--ndjson");
  }

  await serveHub();
};
