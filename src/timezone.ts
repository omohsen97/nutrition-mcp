// Timezone helpers. All functions take an IANA zone name (e.g. "America/New_York", "UTC").
// `logged_at` is always stored as a UTC instant; the zone only affects "what day is this?"
// boundary math and human-readable formatting.

export const DEFAULT_TIMEZONE = "America/New_York";

export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

// "YYYY-MM-DD" for an instant rendered in the given zone.
export function dateInZone(instant: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(instant);
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    const d = parts.find((p) => p.type === "day")!.value;
    return `${y}-${m}-${d}`;
}

export function todayInZone(tz: string): string {
    return dateInZone(new Date(), tz);
}

// Offset in ms between UTC and `tz` at the given instant. EDT → -4*3600*1000.
function zoneOffsetMs(instant: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(instant);
    const get = (t: string) =>
        parseInt(parts.find((p) => p.type === t)!.value, 10);
    let hour = get("hour");
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        hour,
        get("minute"),
        get("second"),
    );
    return asUtc - instant.getTime();
}

// Convert a wall-clock time in `tz` to its UTC instant. DST-correct via two-pass.
function wallClockToUtc(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    s: number,
    ms: number,
    tz: string,
): Date {
    const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
    const offset = zoneOffsetMs(guess, tz);
    return new Date(guess.getTime() - offset);
}

// UTC ISO string for the first instant of `date` (YYYY-MM-DD) in `tz`.
export function startOfLocalDayUtc(date: string, tz: string): string {
    const [y, m, d] = date.split("-").map(Number);
    return wallClockToUtc(y!, m!, d!, 0, 0, 0, 0, tz).toISOString();
}

// UTC ISO string for the last instant of `date` (YYYY-MM-DD) in `tz`.
export function endOfLocalDayUtc(date: string, tz: string): string {
    const [y, m, d] = date.split("-").map(Number);
    return wallClockToUtc(y!, m!, d!, 23, 59, 59, 999, tz).toISOString();
}

// Human-readable "YYYY-MM-DD HH:MM TZABBR" for display.
export function formatInstantInZone(isoInstant: string, tz: string): string {
    const date = new Date(isoInstant);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    let hour = get("hour");
    if (hour === "24") hour = "00";
    const hm = `${hour}:${get("minute")}`;
    const zone = get("timeZoneName");
    return `${ymd} ${hm} ${zone}`;
}
