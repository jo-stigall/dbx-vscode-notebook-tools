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
 */
import type { DriverClient, DriverModule, DriverOperation, DriverSession } from '../../../src/tableViz/host/clusterRunner.ts';
import { answerStatement } from './warehouse.ts';

export interface FakeDriver {
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

/** Give a value the JavaScript type that the real driver gives for that column. */
function typed(column: string, text: string | null): unknown {
  if (text === null) return null;
  if (/^(n|nn|total|bucket|zeros|negatives|version|numFiles|sizeInBytes|c\d+_(nn|d))$/.test(column)) return BigInt(text);
  if (/^(mean|stddev|p\d|c\d+_avg)$/.test(column)) return Number(text);
  if (column === 'partitionColumns') return JSON.parse(text);
  return text;
}

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
