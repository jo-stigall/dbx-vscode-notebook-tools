/**
 * Match the columns of two datasets by name, for compare mode.
 *
 * The result is an explicit list of column pairs. This version makes the
 * list from the names. A later version can let the user add a pair of
 * columns with different names, and the code that uses the list does not
 * change.
 */
import { isNumeric, typeFamily } from './kinds.ts';
import type { ColumnInfo } from './schema.ts';

/** One column of A and the column of B that it is compared with. */
export interface ColumnPair {
  a: ColumnInfo;
  b: ColumnInfo;
  /** true if the two types are different text. 'int' and 'INT' are the same type. */
  typesDiffer: boolean;
  /**
   * How the two columns can be compared.
   *
   * - 'same': the types are the same.
   * - 'number': the types are different, but both are numbers. Compare the values as numbers.
   * - 'text': all other differences. Compare only if the user asks for it; both sides are then read as text.
   */
  compareAs: 'same' | 'number' | 'text';
}

export interface SchemaComparison {
  pairs: ColumnPair[];
  /** The columns that only dataset A has, in the sequence of A. */
  onlyA: ColumnInfo[];
  onlyB: ColumnInfo[];
}

/**
 * Match the columns of A and B by name.
 *
 * @example
 * matchColumns(
 *   [{ name: 'id', typeText: 'int' }, { name: 'Region', typeText: 'string' }, { name: 'old', typeText: 'int' }],
 *   [{ name: 'ID', typeText: 'bigint' }, { name: 'region', typeText: 'string' }, { name: 'new', typeText: 'int' }]
 * )
 * // pairs:  id ↔ ID (compareAs 'number'), Region ↔ region (compareAs 'same')
 * // onlyA:  old
 * // onlyB:  new
 *
 * @param options.caseSensitive  true: 'Region' and 'region' are different names. Default: false.
 *   If B has two columns whose names differ only in case, a column of A matches the one with exactly the same name, if there is one.
 */
export function matchColumns(a: ColumnInfo[], b: ColumnInfo[], options: { caseSensitive?: boolean } = {}): SchemaComparison {
  const key = (name: string) => (options.caseSensitive ? name : name.toLowerCase());
  const used = new Set<ColumnInfo>();
  const pairs: ColumnPair[] = [];
  const onlyA: ColumnInfo[] = [];
  for (const column of a) {
    const candidates = b.filter((other) => !used.has(other) && key(other.name) === key(column.name));
    const match = candidates.find((other) => other.name === column.name) ?? candidates[0];
    if (!match) {
      onlyA.push(column);
      continue;
    }
    used.add(match);
    const typesDiffer = column.typeText.trim().toLowerCase() !== match.typeText.trim().toLowerCase();
    const bothNumbers = isNumeric(typeFamily(column.typeText)) && isNumeric(typeFamily(match.typeText));
    pairs.push({ a: column, b: match, typesDiffer, compareAs: !typesDiffer ? 'same' : bothNumbers ? 'number' : 'text' });
  }
  return { pairs, onlyA, onlyB: b.filter((column) => !used.has(column)) };
}
