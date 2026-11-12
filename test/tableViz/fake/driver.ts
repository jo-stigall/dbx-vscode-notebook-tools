/**
 * A fake of the Databricks SQL Driver for Node.js, for tests of the cluster runner.
 *
 * It has the client, session and operation objects that the runner uses.
 * Like the fake warehouse, it answers each statement from the demo tables.
 * Unlike a warehouse, it returns JavaScript values, as the real driver
 * does: a count is a bigint, a mean is a number, a list is an array.
 *
 * A test can tell the fake to fail in the ways that a cluster fails: an
 * expired token, a session that ended, a statement that never finishes.
 *
 * The fake is different from the real driver (`@databricks/sql`) in these ways:
 *
 * - It opens no connection. `connect` records its options and does nothing more.
 * - It does not run SQL. It knows only the statements that sql.ts builds, for
 *   the demo tables. It ignores a filter, a version and a sample.
 * - It accepts each token, until a test adds the token to `expiredTokens`.
 * - The answer of a statement is ready at once, unless a test sets `hold`.
 *
 * Thus no test shows that the real driver can talk to a real cluster.
 *
 * Two tests use this file:
 *
 *     npm run test:unit    test/tableViz/unit/cluster.test.ts
 *     npm run test:e2e     test/tableViz/integration/workspace.cjs (through dist/test/fakeWorkspace.cjs)
 */
import type { DriverClient, DriverModule, DriverOperation, DriverSession } from '../../../src/tableViz/host/clusterRunner.ts';
import { answerStatement } from './warehouse.ts';

/**
 * A fake driver, and the record of what the cluster runner did with it.
 *
 * A test reads the lists and the counts after a statement. A test sets
 * `expiredTokens`, `failNext` and `hold` to make the next statements fail.
 */
export interface FakeDriver {
  /** The object that takes the place of the `@databricks/sql` module. Return it from the `loadDriver` function of the runner. */
  module: DriverModule;
  /** The options of each connect call, oldest first. */
  connects: Record<string, unknown>[];
  /** The tags of each session. */
  sessions: (Record<string, string> | undefined)[];
  /** Each statement and its options. */
  statements: { sql: string; options: Record<string, unknown> }[];
  /** How many times the runner cancelled an operation, and closed an operation, a session and a client. */
  cancels: number;
  closedOperations: number;
  closedSessions: number;
  closedClients: number;
  /** The fake refuses a statement while its session uses one of these tokens, with the message of an expired token. */
  expiredTokens: Set<string>;
  /** The next statements fail with this message, one statement for each entry. */
  failNext: string[];
  /** true: a statement does not finish until the runner cancels it. */
  hold: boolean;
}

/**
 * Give a value the JavaScript type that the real driver gives for that column.
 *
 * The fake warehouse returns each value as text. The name of the column tells
 * the function which type the real driver returns.
 *
 * @example
 * typed('n', '110000')                          // 110000n: a count is a bigint
 * typed('mean', '63.0015')                      // 63.0015
 * typed('partitionColumns', '["order_date"]')   // ['order_date']
 * typed('value', 'EMEA')                        // 'EMEA'
 * typed('min', null)                            // null
 *
 * @param column  The name of the column in the result, for example 'n' or 'c0_avg'.
 * @param text  The value as the fake warehouse returns it.
 */
function typed(column: string, text: string | null): unknown {
  if (text === null) return null;
  if (/^(n|nn|total|bucket|zeros|negatives|version|numFiles|sizeInBytes|c\d+_(nn|d))$/.test(column)) return BigInt(text);
  if (/^(mean|stddev|p\d|c\d+_avg)$/.test(column)) return Number(text);
  if (column === 'partitionColumns') return JSON.parse(text);
  return text;
}

/**
 * Make a fake driver for one test.
 *
 * @example
 * const fake = makeFakeDriver();
 * const runner = new ClusterRunner({ loadDriver: () => fake.module, host, httpPath, token, timeoutSeconds, tags });
 * await runner.run(statement);
 * fake.connects.length      // 1
 * fake.statements[0]?.sql   // the SQL text that the runner sent
 * fake.hold = true;         // the next statement does not finish until the runner cancels it
 *
 * @returns The fake. Each call returns a new fake with empty lists and counts of 0.
 */
export function makeFakeDriver(): FakeDriver {
  const fake: FakeDriver = {
    module: undefined as unknown as DriverModule,
    connects: [],
    sessions: [],
    statements: [],
    cancels: 0,
    closedOperations: 0,
    closedSessions: 0,
    closedClients: 0,
    expiredTokens: new Set(),
    failNext: [],
    hold: false,
  };

  /**
   * One statement that the runner started. The fake of an operation of the driver.
   *
   * - The constructor reads `namedParameters` from the options of `executeStatement`.
   *   It changes the type name 'INTEGER' of the driver to 'INT', which the fake warehouse reads.
   * - `id` is the ID that the runner reports for the statement, for example 'op-1'.
   * - `compute` asks the fake warehouse for the answer one time and keeps it.
   *   It gives each value its JavaScript type (see `typed`).
   *   While `fake.hold` is true, `compute` waits until the runner calls `cancel`. Then it fails.
   * - `fetchAll` returns the rows as objects, and `getSchema` returns the column names, as the real driver does.
   * - `cancel` and `close` add 1 to `fake.cancels` and `fake.closedOperations`.
   */
  class Operation implements DriverOperation {
    readonly id: string;
    private readonly sql: string;
    private readonly params: { name: string; value: string; type: 'STRING' | 'INT' | 'DOUBLE' }[];
    private rejectHeld: ((error: Error) => void) | undefined;
    private result: Promise<{ names: string[]; rows: object[] }> | undefined;

    constructor(id: string, sql: string, options: Record<string, unknown>) {
      this.id = id;
      this.sql = sql;
      const named = (options.namedParameters ?? {}) as Record<string, { type: string; value: string }>;
      const types: Record<string, 'STRING' | 'INT' | 'DOUBLE'> = { STRING: 'STRING', INTEGER: 'INT', DOUBLE: 'DOUBLE' };
      this.params = Object.entries(named).map(([name, p]) => ({ name, value: p.value, type: types[p.type] ?? 'STRING' }));
    }

    private compute(): Promise<{ names: string[]; rows: object[] }> {
      this.result ??= (async () => {
        if (fake.hold) await new Promise<never>((_resolve, reject) => (this.rejectHeld = reject));
        const answer = await answerStatement({ sql: this.sql, params: this.params });
        const names = answer.columns.map((c) => c.name);
        return { names, rows: answer.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, typed(name, row[i] ?? null)]))) };
      })();
      return this.result;
    }

    async fetchAll(): Promise<object[]> {
      return (await this.compute()).rows;
    }
    async getSchema() {
      return { columns: (await this.compute()).names.map((columnName) => ({ columnName })) };
    }
    async cancel() {
      fake.cancels++;
      this.rejectHeld?.(new Error('The operation was cancelled.'));
    }
    async close() {
      fake.closedOperations++;
    }
  }

  /**
   * One session of the fake cluster. It remembers the token of its connection.
   *
   * `executeStatement` records the statement in `fake.statements`. Then it does one of three things:
   *
   * - The token of the session is in `fake.expiredTokens`: it throws the error of an expired token.
   * - `fake.failNext` is not empty: it throws an error with the first message of that list.
   * - If not: it returns a new `Operation` with the ID 'op-1', 'op-2' and so on.
   *
   * `close` adds 1 to `fake.closedSessions`.
   */
  class Session implements DriverSession {
    private readonly token: string;
    constructor(token: string) {
      this.token = token;
    }
    async executeStatement(sql: string, options: Record<string, unknown>): Promise<DriverOperation> {
      fake.statements.push({ sql, options });
      if (fake.expiredTokens.has(this.token)) throw new Error('Error during request to server: Invalid access token. (HTTP 401)');
      const failure = fake.failNext.shift();
      if (failure) throw new Error(failure);
      return new Operation(`op-${fake.statements.length}`, sql, options);
    }
    async close() {
      fake.closedSessions++;
    }
  }

  /**
   * The fake of `DBSQLClient`.
   *
   * - `connect` records its options in `fake.connects` and keeps the token. It opens no connection.
   * - `openSession` records the tags of the session in `fake.sessions` and returns a new `Session`.
   * - `close` adds 1 to `fake.closedClients`.
   */
  class Client implements DriverClient {
    private token = '';
    async connect(options: Record<string, unknown>) {
      fake.connects.push(options);
      this.token = String(options.token);
      return this;
    }
    async openSession(request?: { queryTags?: Record<string, string> }) {
      fake.sessions.push(request?.queryTags);
      return new Session(this.token);
    }
    async close() {
      fake.closedClients++;
    }
  }

  /** The fake of `DBSQLParameter`: the value of one named parameter and its type, for example 'INTEGER'. */
  class Parameter {
    readonly type?: string;
    readonly value: string;
    constructor(options: { type?: string; value: string }) {
      this.type = options.type;
      this.value = options.value;
    }
  }

  fake.module = { DBSQLClient: Client, DBSQLParameter: Parameter };
  return fake;
}
