/**
 * Read and write the names of tables and columns.
 *
 * A name can contain spaces, dots and other special characters. Databricks
 * then writes the name between backticks, and writes a backtick in the name
 * as two backticks.
 */
import type { TableName } from './schema.ts';

/**
 * Put a name between backticks. Write each backtick in the name twice.
 *
 * @example
 * quoteIdentifier('orders')        // '`orders`'
 * quoteIdentifier('my `odd` name') // '`my ``odd`` name`'
 */
export function quoteIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Write a table name with backticks around each part.
 *
 * @example
 * quoteTableName({ catalog: 'main', schema: 'sales', name: 'orders' })   // '`main`.`sales`.`orders`'
 */
export function quoteTableName(table: TableName): string {
  return [table.catalog, table.schema, table.name].map(quoteIdentifier).join('.');
}

/**
 * Write a table name for a person to read. Use backticks only for a part that needs them.
 *
 * @example
 * displayTableName({ catalog: 'main', schema: 'sales', name: 'orders' })      // 'main.sales.orders'
 * displayTableName({ catalog: 'main', schema: 'sales', name: 'my orders' })   // 'main.sales.`my orders`'
 */
export function displayTableName(table: TableName): string {
  return [table.catalog, table.schema, table.name].map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : quoteIdentifier(part))).join('.');
}

/**
 * Read a three-part table name that a person typed.
 *
 * @example
 * parseTableName('main.sales.orders')         // { catalog: 'main', schema: 'sales', name: 'orders' }
 * parseTableName('main.sales.`my.orders`')    // { catalog: 'main', schema: 'sales', name: 'my.orders' }
 * parseTableName('sales.orders')              // undefined: the name has two parts
 *
 * @param text  The name. Each part can be between backticks.
 * @returns The three parts, or undefined if the text is not a three-part name.
 */
export function parseTableName(text: string): TableName | undefined {
  const parts: string[] = [];
  const s = text.trim();
  let i = 0;
  while (i < s.length) {
    let part = '';
    if (s[i] === '`') {
      i++;
      for (;;) {
        if (i >= s.length) return undefined; // no closing backtick
        if (s[i] === '`') {
          if (s[i + 1] === '`') {
            part += '`';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        part += s[i++];
      }
    } else {
      while (i < s.length && s[i] !== '.') {
        if (s[i] === '`' || /\s/.test(s[i] as string)) return undefined;
        part += s[i++];
      }
    }
    if (!part) return undefined;
    parts.push(part);
    if (i < s.length) {
      if (s[i] !== '.' || i === s.length - 1) return undefined;
      i++;
    }
  }
  if (parts.length !== 3) return undefined;
  return { catalog: parts[0] as string, schema: parts[1] as string, name: parts[2] as string };
}

/**
 * Find a three-part table name at a position in a line of text.
 *
 * @example
 * tableNameAt('SELECT * FROM main.sales.orders WHERE x = 1', 20)   // { catalog: 'main', schema: 'sales', name: 'orders' }
 * tableNameAt('df = spark.table("main.sales.`my orders`")', 25)    // { catalog: 'main', schema: 'sales', name: 'my orders' }
 * tableNameAt('SELECT 1', 3)                                       // undefined
 *
 * @param line  One line of a .sql or .py file.
 * @param character  The position of the cursor in the line, from 0.
 */
export function tableNameAt(line: string, character: number): TableName | undefined {
  const part = '(?:`(?:[^`]|``)+`|[\\p{L}\\p{N}_$]+)';
  const pattern = new RegExp(`${part}\\.${part}\\.${part}`, 'gu');
  for (const match of line.matchAll(pattern)) {
    if (character >= match.index && character <= match.index + match[0].length) return parseTableName(match[0]);
  }
  return undefined;
}
