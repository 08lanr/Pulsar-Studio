/** Only operational email failures are public; account-specific errors stay masked. */
export function magicEmailFailure(error: { status?: number; code?: string } | null):
  "rate_limited" | "unavailable" | null {
  if (!error) return null;
  if (error.status === 429 || error.code === "email_rate_limit_exceeded" ||
      error.code === "over_email_send_rate_limit") return "rate_limited";
  if ((error.status ?? 0) >= 500) return "unavailable";
  return null;
}
