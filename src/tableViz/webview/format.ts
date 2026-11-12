/**
 * Write numbers, sizes and dates for a person to read.
 *
 * The overview, the cards and the tooltips of the charts use these functions,
 * so a number looks the same at each place on the board. The separators and
 * the date format come from the language of the user. The examples show
 * English.
 */

/** Writes a whole number with separators between the groups of digits. */
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
/** Writes a number with 4 significant digits at most. */
const compact = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

/**
 * Write a count with separators.
 *
 * @example
 * formatCount(110000)   // '110,000'
 * formatCount(1234.6)   // '1,235': a count has no decimals
 */
export const formatCount = (n: number): string => integer.format(n);

/**
 * Write a number with 4 significant digits at most.
 *
 * Use it where space is small: a label on an axis, a tooltip, a tile.
 *
 * @example
 * formatNumber(62.48213)   // '62.48'
 * formatNumber(1234567)    // '1,235,000'
 */
export const formatNumber = (n: number): string => compact.format(n);

/**
 * Write a part of a total as a percent with one decimal at most.
 *
 * The function writes '0%' only for a part that is 0. A very small part
 * becomes '<0.1%'. A part that is almost the total becomes '>99.9%'.
 *
 * @example
 * formatPercent(385, 1000)       // '38.5%'
 * formatPercent(500, 1000)       // '50%'
 * formatPercent(1, 100000)       // '<0.1%'
 * formatPercent(99999, 100000)   // '>99.9%'
 * formatPercent(0, 1000)         // '0%'
 * formatPercent(5, 0)            // '0%': a total of 0 gives no division by zero
 */
export function formatPercent(part: number, total: number): string {
  if (total === 0 || part === 0) return '0%';
  const pct = (part / total) * 100;
  if (pct < 0.1) return '<0.1%';
  if (pct > 99.9 && part < total) return '>99.9%';
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

/**
 * Write a number of bytes with a unit. 1 KB is 1024 bytes.
 *
 * @example
 * formatBytes(512)              // '512 B'
 * formatBytes(3771332)          // '3.6 MB'
 * formatBytes(500 * 1024 ** 3)  // '500.0 GB'
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Write an ISO 8601 time as a date and a time in the time zone of the user.
 *
 * @example
 * formatTime('2026-11-01T02:05:00.000Z')   // '1 Nov 2026, 02:05' for British English in the UTC time zone
 * formatTime('2026-11-01T02:05:00.000Z')   // 'Oct 31, 2026, 10:05 PM' for American English in New York
 * formatTime('not a time')                 // 'not a time'
 *
 * @returns The text that it got, if the text is not a time.
 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Write a value from a result (a string) in a shorter form for a small space.
 *
 * An integer gets separators. A time keeps its date only. All other text
 * stays as it is.
 *
 * @example
 * formatValue('5001109999')                 // '5,001,109,999'
 * formatValue('2026-01-01T00:00:00.000Z')   // '2026-01-01'
 * formatValue('36.38')                      // '36.38'
 */
export function formatValue(value: string): string {
  // BigInt keeps all digits of an integer that is too large for a JavaScript number.
  if (/^-?\d+$/.test(value)) return integer.format(BigInt(value));
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return value;
}

/** Writes a number with 6 significant digits at most. */
const stat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 });

/**
 * Write a statistic, such as a mean, with 6 significant digits at most.
 *
 * @example
 * formatStat(62.4821337)    // '62.4821'
 * formatStat(1234567.891)   // '1,234,570'
 */
export const formatStat = (n: number): string => stat.format(n);
