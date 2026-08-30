// lib/index.test.ts — the import matrix and purity rules of docs/01
// §Architecture enforced structurally:
//   - barrel re-exports domain + ports + theme, never adapters
//   - domain modules import nothing outside lib/domain
//   - ports import domain only
//   - theme imports nothing
//   - lib imports nothing from omp / @earendil-works / hosts
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LIB = new URL(".", import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...tsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function relImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

const BANNED = ["node:", "bun:", "@earendil-works", "omp", "child_process"];

describe("barrel (lib/index.ts) — docs/01 import matrix", () => {
  const specs = relImports(join(LIB, "index.ts"));

  it("re-exports every domain module", () => {
    for (const m of ["command", "session", "attention", "summary", "filter"]) {
      expect(specs).toContain(`./domain/${m}`);
    }
  });

  it("re-exports every port module", () => {
    for (const m of ["status_store", "summary_store", "attention_store", "event_bus", "agent_runtime", "clock"]) {
      expect(specs).toContain(`./ports/${m}`);
    }
  });

  it("re-exports theme", () => {
    expect(specs).toContain("./theme");
  });

  it("never touches adapters (subpaths only)", () => {
    expect(specs.filter((s) => s.includes("adapters"))).toEqual([]);
  });

  it("imports only relative lib paths — no external or std deps", () => {
    for (const s of specs) {
      expect(s.startsWith(".")).toBe(true);
    }
  });
});

describe("domain purity — imports nothing (docs/01 layer table)", () => {
  const files = tsFiles(join(LIB, "domain"));

  it("covers the five domain modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("every domain file imports only ../domain siblings or nothing", () => {
    for (const f of files) {
      for (const s of relImports(f)) {
        const target = s.startsWith(".") ? s : `EXTERNAL:${s}`;
        if (target.startsWith("EXTERNAL:")) {
          throw new Error(`${relative(LIB, f)} imports external module ${s} — domain imports nothing`);
        }
        expect(s.startsWith(".")).toBe(true);
      }
      const src = readFileSync(f, "utf8");
      for (const b of BANNED) {
        expect(src.includes(`"${b}`) || src.includes(`'${b}`), `${relative(LIB, f)} must not import ${b}`).toBe(false);
      }
    }
  });
});

describe("ports — import domain only (docs/01 layer table)", () => {
  const files = tsFiles(join(LIB, "ports"));

  it("covers the six ports", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("every port file imports only domain modules", () => {
    for (const f of files) {
      for (const s of relImports(f)) {
        expect(s, `${relative(LIB, f)} imports ${s} — ports may import ../domain/* only`).toMatch(/^\.\.\/domain\//);
      }
    }
  });
});

describe("theme — the one definition, zero imports (docs/01 DRY rules)", () => {
  it("imports nothing", () => {
    expect(relImports(join(LIB, "theme.ts"))).toEqual([]);
  });

  it("pins the five spec token hexes", () => {
    const src = readFileSync(join(LIB, "theme.ts"), "utf8");
    for (const hex of ["#70e1c4", "#3fd68f", "#f5c04e", "#ff7a9a", "#8b97b0"]) {
      expect(src).toContain(hex);
    }
  });
});

describe("lib-wide — no omp/@earendil-works/host imports (docs/01)", () => {
  it("no non-test lib file references banned sources", () => {
    for (const f of tsFiles(LIB)) {
      const src = readFileSync(f, "utf8");
      expect(src, relative(LIB, f)).not.toMatch(/from\s+["']@earendil-works/);
      expect(src, relative(LIB, f)).not.toMatch(/from\s+["'](node|bun):/);
    }
  });

  it("ports files import nothing else but domain (string scan incl. side-effect imports)", () => {
    for (const f of tsFiles(join(LIB, "ports"))) {
      const src = readFileSync(f, "utf8");
      const all = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of all) {
        expect(s).toMatch(/^\.\.\/domain\//);
      }
    }
  });
});
