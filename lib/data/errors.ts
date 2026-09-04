// The one error shape the data layer throws. Both implementations raise the
// same codes for the same guards (the fixture store re-implements what the
// SQL functions and RLS enforce in supabase mode), so a route handler maps a
// DataError to a status once and never looks at the backend.

export type DataErrorCode = "not_found" | "forbidden" | "invalid" | "frozen" | "conflict";

export class DataError extends Error {
  readonly code: DataErrorCode;

  constructor(code: DataErrorCode, message: string) {
    super(message);
    this.name = "DataError";
    this.code = code;
  }
}

/** HTTP status per code; `frozen` is a conflict with the version's state, so 409 like `conflict`. */
export const DATA_ERROR_STATUS: Record<DataErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  frozen: 409,
  conflict: 409,
};

export function isDataError(e: unknown): e is DataError {
  return e instanceof DataError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "DataError");
}

/** Status for any thrown value: a DataError's code, else 500. */
export function dataErrorStatus(e: unknown): number {
  return isDataError(e) ? DATA_ERROR_STATUS[e.code] : 500;
}

export function notFound(what: string, id?: string): DataError {
  return new DataError("not_found", id ? `${what} ${id} not found` : `${what} not found`);
}

export function forbidden(message: string): DataError {
  return new DataError("forbidden", message);
}

export function invalid(message: string): DataError {
  return new DataError("invalid", message);
}

export function frozen(message: string): DataError {
  return new DataError("frozen", message);
}

export function conflict(message: string): DataError {
  return new DataError("conflict", message);
}
