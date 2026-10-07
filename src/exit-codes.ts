/** CLI exit codes (documented in the README and SPEC). */
export const EXIT = {
  /** Every checked invariant held (run), or every run matched its expectation (suite). */
  OK: 0,
  /** The deployment violated an invariant (run), or a run did not match its expectation (suite). */
  VIOLATION: 1,
  /** Invalid arguments, unknown scenario, unsupported combination, or a report that does not validate. */
  USAGE: 2,
  /** The run could not reach the state it needed to test (worker did not start, chain unreachable, evidence inconsistent). */
  INCONCLUSIVE: 3,
} as const;
