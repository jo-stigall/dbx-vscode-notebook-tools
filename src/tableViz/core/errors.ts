/**
 * Convert an error from Databricks to a message that tells the user what to do.
 *
 * Databricks reports errors as codes and long technical text. This file
 * knows the common ones. For each it gives one plain sentence and one next
 * step. The UI always lets the user open the original text and the SQL.
 */
import { displayTableName } from './names.ts';
import { ProfilerError } from './profiler.ts';
import { QueryError } from './runner.ts';
import type { TableName } from './schema.ts';

export interface ErrorContext {
  /** The table of the request. */
  table: TableName;
  /** The SQL statements of the request, as text for the user. */
  sql: string[];
  /** The time limit of a statement, in seconds. */
  timeoutSeconds: number;
  /** What ran the statement, for the message. Example: 'The warehouse "Shared"'. */
  compute: string;
  /** The workspace URL, for the login command. */
  host: string;
}

/** A plain message and a next step for one kind of error. */
interface Advice {
  message: string;
  nextStep: string;
}

/**
 * Find the advice for an error. Returns undefined for an error that the file does not know.
 *
 * The function looks at the error code, the SQLSTATE and the HTTP status
 * first, and at words in the text only when those are missing.
 */
function advise(error: QueryError, context: ErrorContext): Advice | undefined {
  const table = displayTableName(context.table);
  const text = error.message;
  const code = error.code ?? '';
  const state = error.sqlState ?? '';

  if (error.kind === 'timeout') {
    return {
      message: `The query ran longer than ${context.timeoutSeconds} seconds, and the extension stopped it.`,
      nextStep: 'Add a filter or use a sample. You can also increase the setting "dbxNotebook.tableViz.queryTimeoutSeconds".',
    };
  }
  if (error.status === 401 || /\b(invalid access token|token (is |has )?expired|unauthenticated)\b/i.test(text)) {
    return {
      message: 'Your Databricks login is not valid or it expired.',
      nextStep: `Run "databricks auth login --host ${context.host}" in a terminal, then try again.`,
    };
  }
  if (code.includes('TABLE_OR_VIEW_NOT_FOUND') || state === '42P01' || /TABLE_OR_VIEW_NOT_FOUND|TABLE_DOES_NOT_EXIST/.test(text)) {
    return {
      message: `The table ${table} does not exist, or you are not permitted to see it.`,
      nextStep: 'Check the name of the table. If the name is correct, ask the owner for the SELECT privilege.',
    };
  }
  if (/USE (SCHEMA|CATALOG)/i.test(text) && /privilege|permission/i.test(text)) {
    const what = /USE CATALOG/i.test(text) ? 'USE CATALOG' : 'USE SCHEMA';
    return {
      message: `You do not have the ${what} privilege that ${table} needs.`,
      nextStep: `Ask the owner of the ${what === 'USE CATALOG' ? 'catalog' : 'schema'} for the ${what} privilege.`,
    };
  }
  if (code.includes('INSUFFICIENT_PERMISSIONS') || code.includes('PERMISSION_DENIED') || state === '42501' || error.status === 403 || /does not have (privilege )?SELECT|insufficient (privileges|permissions)/i.test(text)) {
    return {
      message: `You do not have the SELECT privilege on ${table}.`,
      nextStep: 'Ask the owner of the table for the SELECT privilege.',
    };
  }
  if (code.includes('UNRESOLVED_COLUMN') || state === '42703') {
    return {
      message: `A column in the query does not exist in ${table}.`,
      nextStep: 'The table changed, or the filter names a column that the table does not have. Refresh the board and check the filter.',
    };
  }
  if (code.includes('PARSE_SYNTAX_ERROR') || state === '42601') {
    return {
      message: 'Databricks could not read the SQL of the query.',
      nextStep: 'If the dataset has a filter, check the filter. Open "Details" to see the SQL.',
    };
  }
  if (error.status === 404 || /RESOURCE_DOES_NOT_EXIST|(warehouse|cluster|endpoint).*(does not exist|not found|deleted)/i.test(code + ' ' + text)) {
    return {
      message: `${context.compute} does not exist now.`,
      nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a different one.',
    };
  }
  if (/(warehouse|cluster|endpoint).*(stopped|terminated|not running)/i.test(text)) {
    return {
      message: `${context.compute} is stopped.`,
      nextStep: 'Start it in Databricks, or run the query again and permit the extension to start it.',
    };
  }
  if (error.status === 429) {
    return {
      message: 'Databricks refused the request because it received too many requests.',
      nextStep: 'Wait a minute, then click "Refresh".',
    };
  }
  return undefined;
}

/**
 * Make the error that the UI shows from an error of a query runner.
 *
 * @example
 * toProfilerError(new QueryError('[TABLE_OR_VIEW_NOT_FOUND] ...', { kind: 'failed', code: 'TABLE_OR_VIEW_NOT_FOUND' }), context)
 * // ProfilerError: "The table main.sales.orders does not exist, or you are not permitted to see it."
 * //   nextStep: "Check the name of the table. ..."
 * //   raw: "[TABLE_OR_VIEW_NOT_FOUND] ..."
 */
export function toProfilerError(error: unknown, context: ErrorContext): ProfilerError {
  if (error instanceof ProfilerError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const advice = error instanceof QueryError ? advise(error, context) : undefined;
  return new ProfilerError(advice?.message ?? 'Databricks reported an error for this query.', {
    nextStep: advice?.nextStep ?? 'Open "Details" to see the error text from Databricks.',
    raw,
    sql: context.sql,
  });
}
