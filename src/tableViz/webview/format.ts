/** Write numbers, sizes and dates for a person to read. */

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

/**
 * Write a count with separators.
 *
 * @example
 * formatCount(110000)   // '110,000'
 */
export const formatCount = (n: number): string => integer.format(n);

/**
 * Write a number with 4 significant digits at most.
 *
 * @example
 * formatNumber(62.48213)   // '62.48'
 */
export const formatNumber = (n: number): string => compact.format(n);

/**
 * Write a part of a total as a percent.
 *
 * @example
 * formatPercent(385, 1000)   // '38.5%'
 * formatPercent(1, 100000)   // '<0.1%'
 * formatPercent(0, 1000)     // '0%'
 */
export function formatPercent(part: number, total: number): string {
  if (total === 0 || part === 0) return '0%';
  const pct = (part / total) * 100;
  if (pct < 0.1) return '<0.1%';
  if (pct > 99.9 && part < total) return '>99.9%';
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

/**
 * Write a number of bytes with a unit.
 *
 * @example
 * formatBytes(3771332)   // '3.6 MB'
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
 * formatTime('2026-11-01T02:05:00.000Z')   // '1 Nov 2026, 02:05' in the UTC time zone
 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Write a value from a result (a string) in a shorter form for a small space.
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
