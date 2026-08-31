// lib/ports/clock.ts — Clock: injected time; tests freeze it.
// Imports domain only (docs/01-architecture.md §Core abstractions ports).

export type Clock = {
  /** epoch milliseconds */
  now(): number;
};
