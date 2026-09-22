export type ErrorCode = "NOT_FOUND" | "REVISION_CONFLICT" | "INTERNAL_ERROR";

export class ToolboxError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function asToolboxError(error: unknown): ToolboxError {
  return error instanceof ToolboxError
    ? error
    : new ToolboxError(
        "INTERNAL_ERROR",
        "The operation could not be completed.",
      );
}
