/**
 * Decide how to show a column: as a histogram, as bars, as a frequency table, and so on.
 *
 * The decision uses the Databricks type of the column and its number of
 * different values. The user can override the decision in the UI.
 */
import type { ColumnKind } from './schema.ts';

/** A group of Databricks types that the feature handles in the same way. */
export type TypeFamily = 'integer' | 'decimal' | 'float' | 'string' | 'boolean' | 'date' | 'timestamp' | 'complex';

/** A string column with more different values than this is an identifier, not a category. */
export const MAX_CATEGORY_VALUES = 10_000;

/** An integer column with this number of different values or fewer gets one bar for each value. */
export const MAX_DISCRETE_VALUES = 50;

/**
 * Get the type family of a Databricks type.
 *
 * @example
 * typeFamily('BIGINT')           // 'integer'
 * typeFamily('decimal(10,2)')    // 'decimal'
 * typeFamily('array<string>')    // 'complex'
 *
 * @param typeText  The type as Databricks writes it. Upper or lower case.
 */
export function typeFamily(typeText: string): TypeFamily {
  const base = typeText.trim().toLowerCase().replace(/[(<\s].*$/s, '');
  switch (base) {
    case 'tinyint':
    case 'smallint':
    case 'int':
    case 'integer':
    case 'bigint':
    case 'byte':
    case 'short':
    case 'long':
      return 'integer';
    case 'decimal':
    case 'dec':
    case 'numeric':
      return 'decimal';
    case 'float':
    case 'double':
    case 'real':
      return 'float';
    case 'string':
    case 'char':
    case 'varchar':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
    case 'timestamp_ntz':
      return 'timestamp';
    default:
      // array, map, struct, variant, binary, interval and all types that the feature does not know.
      return 'complex';
  }
}

/** Tell if a type family holds numbers. */
export const isNumeric = (family: TypeFamily): boolean => family === 'integer' || family === 'decimal' || family === 'float';

/**
 * Tell if almost every row has a different value, as in an ID column.
 * The rule is: 100 values or more, and at least 95% of them are different.
 */
function nearlyUnique(distinct: number, nonNull: number): boolean {
  return nonNull >= 100 && distinct >= 0.95 * nonNull;
}

/**
 * Decide the kind of a column.
 *
 * | Type                | Different values                    | Kind       |
 * |---------------------|-------------------------------------|------------|
 * | array, map, struct… | any                                 | complex    |
 * | date, timestamp     | any                                 | date       |
 * | integer             | almost all rows are different       | identifier |
 * | integer             | 50 or fewer                         | discrete   |
 * | all other numbers   | any                                 | continuous |
 * | string              | more than 10,000, or almost all rows | identifier |
 * | string, boolean     | all other cases                     | category   |
 *
 * A decimal or float column is never an identifier, because a measurement
 * such as a weight is also different in almost every row.
 *
 * @example
 * detectKind('bigint', 100_000, 100_000)   // 'identifier': an ID column
 * detectKind('int', 8, 100_000)            // 'discrete'
 * detectKind('double', 5_000, 100_000)     // 'continuous'
 * detectKind('string', 4, 100_000)         // 'category'
 *
 * @param typeText  The Databricks type of the column.
 * @param distinct  The number of different values. Omit it if you do not know it; the function then uses the type only.
 * @param nonNull  The number of rows where the column is not null.
 */
export function detectKind(typeText: string, distinct: number | undefined, nonNull: number): ColumnKind {
  const family = typeFamily(typeText);
  if (family === 'complex') return 'complex';
  if (family === 'date' || family === 'timestamp') return 'date';
  if (family === 'boolean') return 'category';
  if (family === 'string') {
    if (distinct !== undefined && (distinct > MAX_CATEGORY_VALUES || nearlyUnique(distinct, nonNull))) return 'identifier';
    return 'category';
  }
  if (family === 'integer' && distinct !== undefined) {
    if (nearlyUnique(distinct, nonNull)) return 'identifier';
    if (distinct <= MAX_DISCRETE_VALUES) return 'discrete';
  }
  return 'continuous';
}
