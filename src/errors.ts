/**
 * Raised when a store cannot give a trustworthy answer. Callers must treat it as
 * "do not accept": a worker that cannot reach the shared store has no way to know
 * whether a credential was already consumed.
 */
export type StoreFaultCode = "busy" | "removed" | "io" | "closed" | "invalid_value";

export class StoreUnavailableError extends Error {
  readonly code: StoreFaultCode;
  constructor(code: StoreFaultCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreUnavailableError";
    this.code = code;
  }
}

/** Raised for configuration that must stop a worker from starting. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
