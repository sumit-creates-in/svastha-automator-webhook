/**
 * Timezone-aware date maths and formatting, with no dependencies.
 *
 * Everything goes through `Intl.DateTimeFormat`, which ships with Node and
 * handles daylight saving and regional calendars properly — safer than
 * hand-rolled offset arithmetic, and lighter than pulling in a date library.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Parses the things people actually put in a webhook: ISO strings, epoch
 * seconds or milliseconds, `DD/MM/YYYY`, and Date objects. Returns null rather
 * than an Invalid Date so callers can decide what to do.
 */
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    // Ten-digit values are epoch seconds; anything longer is milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) return parseDate(Number(text));

  // DD/MM/YYYY or DD-MM-YYYY, which JavaScript otherwise reads as US order.
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dmy;
    const date = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  offsetLabel: string;
}

/** The calendar fields of an instant, as seen in a given timezone. */
export function getParts(date: Date, timezone = DEFAULT_TIMEZONE): DateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    });
  } catch {
    // An unknown timezone should degrade to UTC, not crash a workflow.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    });
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: DAYS_LONG.findIndex((name) => name.startsWith(parts.weekday ?? '')),
    offsetLabel: (parts.timeZoneName ?? 'UTC').replace('GMT', 'UTC'),
  };
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * Formats a date using familiar tokens, so a date and a time can be combined
 * into one string: `DD MMM YYYY, h:mm a` -> `07 Aug 2026, 2:50 pm`.
 *
 * Text that should be left alone goes in square brackets: `[Received on] DD MMM`.
 *
 * | Token | Meaning              | Example  |
 * |-------|----------------------|----------|
 * | YYYY  | four-digit year      | 2026     |
 * | YY    | two-digit year       | 26       |
 * | MMMM  | month name           | August   |
 * | MMM   | short month          | Aug      |
 * | MM    | padded month         | 08       |
 * | M     | month                | 8        |
 * | DD    | padded day           | 07       |
 * | D     | day                  | 7        |
 * | Do    | day with ordinal     | 7th      |
 * | dddd  | weekday              | Friday   |
 * | ddd   | short weekday        | Fri      |
 * | HH/H  | 24-hour              | 14       |
 * | hh/h  | 12-hour              | 02 / 2   |
 * | mm/m  | minutes              | 50       |
 * | ss/s  | seconds              | 09       |
 * | A/a   | AM PM / am pm        | pm       |
 * | Z     | timezone label       | UTC+5:30 |
 */
export function formatDateTime(
  value: unknown,
  pattern = 'DD MMM YYYY, h:mm a',
  timezone = DEFAULT_TIMEZONE,
): string {
  const date = parseDate(value);
  if (!date) return '';

  const parts = getParts(date, timezone);
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const meridiem = parts.hour < 12 ? 'am' : 'pm';

  const tokens: Record<string, string> = {
    YYYY: String(parts.year),
    YY: String(parts.year).slice(-2),
    MMMM: MONTHS_LONG[parts.month - 1] ?? '',
    MMM: (MONTHS_LONG[parts.month - 1] ?? '').slice(0, 3),
    MM: String(parts.month).padStart(2, '0'),
    M: String(parts.month),
    DD: String(parts.day).padStart(2, '0'),
    Do: ordinal(parts.day),
    D: String(parts.day),
    dddd: DAYS_LONG[parts.weekday] ?? '',
    ddd: (DAYS_LONG[parts.weekday] ?? '').slice(0, 3),
    HH: String(parts.hour).padStart(2, '0'),
    H: String(parts.hour),
    hh: String(hour12).padStart(2, '0'),
    h: String(hour12),
    mm: String(parts.minute).padStart(2, '0'),
    m: String(parts.minute),
    ss: String(parts.second).padStart(2, '0'),
    s: String(parts.second),
    A: meridiem.toUpperCase(),
    a: meridiem,
    Z: parts.offsetLabel,
  };

  // Longest tokens first so MMMM is not eaten by MMM.
  const pattern_ = /\[([^\]]*)]|YYYY|MMMM|dddd|MMM|ddd|YY|MM|DD|Do|HH|hh|mm|ss|M|D|H|h|m|s|A|a|Z/g;

  return pattern.replace(pattern_, (match, literal?: string) => {
    if (literal !== undefined) return literal;
    return tokens[match] ?? match;
  });
}

export type DateUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/** Adds (or with a negative amount, subtracts) a period. */
export function addToDate(value: unknown, amount: number, unit: DateUnit): Date | null {
  const date = parseDate(value);
  if (!date) return null;

  if (unit === 'months' || unit === 'years') {
    // Calendar arithmetic, so 31 Jan + 1 month lands on 28/29 Feb rather than in March.
    const result = new Date(date.getTime());
    const target = unit === 'years' ? result.getUTCFullYear() + amount : result.getUTCFullYear();
    const month = unit === 'months' ? result.getUTCMonth() + amount : result.getUTCMonth();
    const day = result.getUTCDate();

    result.setUTCFullYear(target, month, 1);
    const lastDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
  }

  return new Date(date.getTime() + amount * (UNIT_MS[unit] ?? UNIT_MS.days));
}

/** Difference between two instants, expressed in `unit`. */
export function diffDates(from: unknown, to: unknown, unit: DateUnit = 'days'): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;

  const ms = b.getTime() - a.getTime();

  if (unit === 'years') return ms / (365.25 * UNIT_MS.days);
  if (unit === 'months') return ms / (30.44 * UNIT_MS.days);
  return ms / (UNIT_MS[unit] ?? UNIT_MS.days);
}

/**
 * Converts a wall-clock time in `timezone` into the matching UTC instant.
 *
 * Uses the standard two-pass trick: treat the wall time as if it were UTC, see
 * what that instant looks like in the target zone, and subtract the difference.
 * This gets daylight saving right without hard-coding any offsets.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  timezone = DEFAULT_TIMEZONE,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const seen = getParts(new Date(guess), timezone);
  const seenAsUtc = Date.UTC(
    seen.year,
    seen.month - 1,
    seen.day,
    seen.hour,
    seen.minute,
    seen.second,
  );
  return new Date(guess - (seenAsUtc - guess));
}

/** Midnight at the start of the day, as seen in `timezone`. */
export function startOfDay(value: unknown, timezone = DEFAULT_TIMEZONE): Date | null {
  const date = parseDate(value);
  if (!date) return null;
  const parts = getParts(date, timezone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timezone);
}

/** The last second of the day, as seen in `timezone`. */
export function endOfDay(value: unknown, timezone = DEFAULT_TIMEZONE): Date | null {
  const date = parseDate(value);
  if (!date) return null;
  const parts = getParts(date, timezone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 23, 59, 59, timezone);
}

/** True when both instants fall on the same calendar day in `timezone`. */
export function isSameDay(a: unknown, b: unknown, timezone = DEFAULT_TIMEZONE): boolean {
  const first = parseDate(a);
  const second = parseDate(b);
  if (!first || !second) return false;

  const x = getParts(first, timezone);
  const y = getParts(second, timezone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** "3 days ago", "in 2 hours". */
export function relativeToNow(value: unknown, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return '';

  const seconds = (date.getTime() - now.getTime()) / 1000;
  const future = seconds > 0;
  const magnitude = Math.abs(seconds);

  const steps: Array<[number, string]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
    [Infinity, 'year'],
  ];

  const divisors: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2629800,
    year: 31557600,
  };

  const unit = steps.find(([limit]) => magnitude < limit)?.[1] ?? 'year';
  const count = Math.max(1, Math.round(magnitude / divisors[unit]));
  const plural = count === 1 ? unit : `${unit}s`;

  return future ? `in ${count} ${plural}` : `${count} ${plural} ago`;
}
