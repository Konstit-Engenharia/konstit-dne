/** A user-facing CLI failure carrying a stable code, exit status, and optional structured details. */
export class UserError extends Error {
  /**
   * Creates an error suitable for both text and JSON CLI output.
   * @param code - Machine-readable identifier for the failure.
   * @param message - Human-readable explanation, already localized for the CLI.
   * @param exitCode - Process status to return; defaults to 1.
   * @param details - Optional context serialized in JSON error output.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
