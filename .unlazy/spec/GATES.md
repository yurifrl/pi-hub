# Gates: pi-hub implementation spec

OWNS: pi-extentions/pi-hub/**

Scope: complete implementation-grade spec for pi-hub — six docs/ modules, integrated SPEC.html with all requirement coverage, re-indexed PLAN.md.

- [x] G1: architecture doc defines hexagonal layering, DRY rules, package tree, import rules, core interfaces, error model, testing
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 01-architecture
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=2146addb4ca290632f3fa80cf93a0b604d8e7f11701694240e6ece0b4c5043d1; output-bytes=81

- [x] G2: data contracts doc defines status.json, logs, summaries, archive schemas, socket protocol, attention lifecycle
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 02-data-contracts
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=fef96758f441f9a7886170fcc9eb774f99307b19d32e06bce39c2adc2c9777fd; output-bytes=83

- [x] G3: CLI spec covers every command with args, flags, outputs, errors, keys, and terminal sketches
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 03-cli
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=d82f8fa7ca2295b615f20b6af0132c894b5adb57f6361b8e8adb243db1d8bc2e; output-bytes=72

- [x] G4: web spec covers routes, SSE event contract, page wireframes, security stance
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 04-web
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=85071ac20d313c242bc96762a6cc1cc9b8019aa21057a4f761b029508ebb2413; output-bytes=72

- [x] G5: omp plugin spec covers entry, reporter, all 9 tools with schemas and routing, widget, agent spawn, shutdown, env vars
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 05-omp-plugin
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=d19d1f2d764ad41abf49421628832ea5c49ac10a3bb2d91fb0e6af4484773027; output-bytes=79

- [x] G6: agents-and-skills doc defines hub agent loop, surface contract, skills and agent files with paths, interaction flows
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-doc.mjs 06-agents-and-skills
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=34e131e032a31f1f2c82a61de677a00cbf946c98d71ce5c2e7be75c1212a917e; output-bytes=86

- [x] G7: spec.html renders the full implementation spec with linked docs and readable in a browser
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-spec-html.mjs
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=bee3270f9e99ac4772e5bedf69d3f2f1b8fcac8e982c87867a4ca733b881d68c; output-bytes=69

- [x] G8: PLAN.md indexes the spec with architecture, DRY, structures, filesystem organization, skills, agents, and implementation detail present
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-plan-index.mjs
  EXPECT: verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=6ca4720447bab48026a0201683d6a36e11fd26c25abc48c9d7a15cb70b646660; output-bytes=94

- [x] G9: contract consistency across all six docs — package names, port names, tool names, file paths agree
  CHECK: node /Users/yuri/DotFiles/pi-extentions/pi-hub/.unlazy/spec/scripts/check-consistency.mjs
  EXPECT: contract consistency verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-hub; path=6fc808956492/31 entries; EXPECT=matched; output-sha256=c544bfb3849ef7d8b19fcefade0961c101eb1a7b35e72185709ef67d9c975ee5; output-bytes=93
