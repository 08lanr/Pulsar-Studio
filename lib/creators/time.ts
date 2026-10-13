// Wall-clock time in a creator account's own time zone (decision 2026-10-12):
// a person picks "Tuesday 8:30" meaning San Francisco's 8:30, whatever the
// browser's zone. Pure and client-safe (Intl only).

function offsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** "2026-10-14T08:30" in `timeZone` → the instant (ISO, UTC). Null when the input is not a wall time. */
export function zonedToUtc(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let at = wall - offsetMs(wall, timeZone);
  at = wall - offsetMs(at, timeZone); // once more across a DST edge
  return new Date(at).toISOString();
}

/** The instant as a datetime-local value in `timeZone` ("2026-10-14T08:30"). */
export function utcToZoned(iso: string, timeZone: string): string {
  const at = Date.parse(iso);
  const local = new Date(at + offsetMs(at, timeZone));
  return local.toISOString().slice(0, 16);
}

/** For people: "Tue, Oct 14, 8:30 AM". */
export function formatInZone(iso: string | null, timeZone: string): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
