/**
 * The session: which profile and which compute the feature uses, and the profiler for each profile.
 *
 * A profile is one of these:
 *
 * | Name              | What it is                                                          |
 * |-------------------|---------------------------------------------------------------------|
 * | 'Demo'            | The built-in demo tables. No workspace.                             |
 * | '@workspace'      | The connection of the notebooks: settings, variables, project file. |
 * | '@token:<URL>'    | A workspace URL with a token in the secret store of VS Code.        |
 * | all other names   | A profile in `~/.databrickscfg`.                                    |
 *
 * VS Code remembers the selection for the open workspace.
 */
import * as vscode from 'vscode';
import { CachingProfiler } from '../core/cache.ts';
import { Limiter } from '../core/limiter.ts';
import { ProfilerError, type CancelSignal, type Profiler } from '../core/profiler.ts';
import type { QueryRunner } from '../core/runner.ts';
import { DemoProfiler } from '../demo/demoProfiler.ts';
import { createHttp, HttpError, type Http } from './http.ts';
import { SqlProfiler } from './sqlProfiler.ts';
import { StatementExecutionRunner } from './statementRunner.ts';
import { DemoWorkspaceClient, RestWorkspaceClient, type WorkspaceClient } from './workspace.ts';

export const DEMO_PROFILE = 'Demo';
export const WORKSPACE_PROFILE = '@workspace';
export const TOKEN_PROFILE_PREFIX = '@token:';

/** The part of the Connection class in src/client.js that the feature uses. */
export interface HostConnection {
  resolve(uri: vscode.Uri | undefined, profile?: string): { host: string; token: string; clusterId: string; cliPath: string };
  getToken(uri: vscode.Uri | undefined, options?: { profile?: string; fresh?: boolean }): Promise<string>;
  listProfiles(): { name: string; host: string; auth: string }[];
  storeToken(host: string, token: string): Promise<string>;
  storedHosts(): string[];
}

/** The compute that runs the queries of a profile. */
export interface Compute {
  kind: 'warehouse';
  id: string;
  name: string;
}

/** What VS Code stores: the selected profile, and the compute that the user selected for each profile. */
interface Stored {
  profile?: string;
  compute?: Record<string, Compute>;
}

const SELECTION_KEY = 'dbxNotebook.tableViz.selection';
/** After this time, the session asks Databricks again if the warehouse runs. A warehouse can stop when it is not used. */
const STATE_CHECK_MS = 120_000;

export class Session {
  private readonly context: vscode.ExtensionContext;
  private readonly conn: HostConnection;
  private readonly log: vscode.LogOutputChannel;
  private readonly demo = new DemoProfiler();
  private readonly profilers = new Map<string, Profiler>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the user selects a different profile or compute, and when the state of the compute changes. */
  readonly onDidChange = this.changed.event;
  /** The last state of the compute that the session saw, for the status bar. Example: 'RUNNING'. */
  computeState: string | undefined;

  constructor(context: vscode.ExtensionContext, conn: HostConnection, log: vscode.LogOutputChannel) {
    this.context = context;
    this.conn = conn;
    this.log = log;
    context.subscriptions.push(this.changed);
  }

  /** A file location for the connection of the notebooks: the first folder of the workspace. */
  private get folder(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private get stored(): Stored {
    return this.context.workspaceState.get<Stored>(SELECTION_KEY) ?? {};
  }

  /** Read the settings "dbxNotebook.tableViz.*". */
  settings() {
    const config = vscode.workspace.getConfiguration('dbxNotebook.tableViz');
    const positive = (name: string, fallback: number) => {
      const value = config.get<number>(name);
      return typeof value === 'number' && value > 0 ? value : fallback;
    };
    return {
      warehouseId: (config.get<string>('warehouseId') ?? '').trim(),
      confirmComputeStart: config.get<boolean>('confirmComputeStart') !== false,
      maxConcurrentQueries: positive('maxConcurrentQueries', 4),
      queryTimeoutSeconds: positive('queryTimeoutSeconds', 300),
      largeTableWarningGB: positive('largeTableWarningGB', 100),
    };
  }

  /**
   * The profile that the feature uses now.
   *
   * If the user selected none: the connection of the notebooks if it has a
   * workspace URL, and the Demo profile if not. Thus the feature works at
   * once on a computer with no Databricks setup.
   */
  get profile(): string {
    return this.stored.profile ?? (this.conn.resolve(this.folder).host ? WORKSPACE_PROFILE : DEMO_PROFILE);
  }

  /** The compute of a profile: the one that the user selected, or the warehouse in the settings. */
  compute(profile: string): Compute | undefined {
    if (profile === DEMO_PROFILE) return undefined;
    const selected = this.stored.compute?.[profile];
    if (selected) return selected;
    const { warehouseId } = this.settings();
    return warehouseId ? { kind: 'warehouse', id: warehouseId, name: warehouseId } : undefined;
  }

  /** Store the profile and its compute. All profilers and their caches are made again. */
  async select(profile: string, compute?: Compute): Promise<void> {
    const stored = this.stored;
    await this.context.workspaceState.update(SELECTION_KEY, {
      profile,
      compute: { ...stored.compute, ...(compute ? { [profile]: compute } : {}) },
    } satisfies Stored);
    this.profilers.clear();
    this.computeState = undefined;
    this.changed.fire();
  }

  /** Store the last state of the compute and tell the status bar. */
  setComputeState(state: string | undefined): void {
    this.computeState = state;
    this.changed.fire();
  }

  /** The workspace URL of a profile. Empty for the Demo profile and for a profile that does not exist. */
  hostOf(profile: string): string {
    if (profile === DEMO_PROFILE) return '';
    return this.conn.resolve(this.folder, profile).host;
  }

  /**
   * The name of a profile for a person to read.
   *
   * @example
   * session.label('@workspace')                              // 'Notebook connection'
   * session.label('@token:https://adb-1.azuredatabricks.net') // 'adb-1.azuredatabricks.net'
   * session.label('prod')                                    // 'prod'
   */
  label(profile: string): string {
    if (profile === WORKSPACE_PROFILE) return 'Notebook connection';
    if (profile.startsWith(TOKEN_PROFILE_PREFIX)) return profile.slice(TOKEN_PROFILE_PREFIX.length).replace(/^https?:\/\//, '');
    return profile;
  }

  /** The REST client of a profile. */
  http(profile: string): Http {
    return createHttp({
      host: () => this.hostOf(profile),
      token: (fresh) => this.conn.getToken(this.folder, { profile, fresh }),
    });
  }

  /** The client that lists the warehouses, catalogs, schemas and tables of a profile. */
  workspace(profile: string): WorkspaceClient {
    return profile === DEMO_PROFILE ? new DemoWorkspaceClient() : new RestWorkspaceClient(this.http(profile));
  }

  /**
   * The profiler of a profile.
   *
   * @throws {ProfilerError}  If the profile has no workspace URL or no compute.
   */
  profilerFor(profile: string): Profiler {
    if (profile === DEMO_PROFILE) return this.demo;
    const existing = this.profilers.get(profile);
    if (existing) return existing;

    const host = this.hostOf(profile);
    if (!host) {
      throw new ProfilerError(`The profile "${this.label(profile)}" has no workspace URL.`, {
        nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a profile.',
      });
    }
    const compute = this.compute(profile);
    if (!compute) {
      throw new ProfilerError(`No SQL warehouse is selected for the profile "${this.label(profile)}".`, {
        nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a warehouse.',
      });
    }

    const http = this.http(profile);
    const workspace = new RestWorkspaceClient(http);
    const runner = new StatementExecutionRunner({
      http,
      warehouseId: compute.id,
      timeoutSeconds: () => this.settings().queryTimeoutSeconds,
      tags: { feature: 'table-viz' },
    });
    const sql = new SqlProfiler({
      runner: this.logged(runner),
      getTable: (table) => workspace.getTable(table),
      limiter: new Limiter(() => this.settings().maxConcurrentQueries),
      describe: () => ({ timeoutSeconds: this.settings().queryTimeoutSeconds, compute: `The warehouse "${compute.name}"`, host }),
      beforeQuery: this.startGuard(compute, workspace),
    });
    const profiler = new CachingProfiler(sql, { hostOf: (p) => this.hostOf(p) });
    this.profilers.set(profile, profiler);
    return profiler;
  }

  /**
   * Add log lines to a runner: the ID, the time and the number of rows of each statement.
   * The SQL text goes to the log only at the "debug" level. A value from a result never goes to the log.
   */
  private logged(runner: QueryRunner): QueryRunner {
    return {
      run: async (statement, options) => {
        const start = Date.now();
        this.log.debug(`tableViz: SQL\n${statement.sql}`);
        try {
          const result = await runner.run(statement, options);
          this.log.info(`tableViz: statement ${result.statementId ?? '?'} done in ${Date.now() - start} ms, ${result.rows.length} rows`);
          return result;
        } catch (e) {
          this.log.info(`tableViz: statement stopped after ${Date.now() - start} ms: ${e instanceof Error ? e.name : 'error'}`);
          throw e;
        }
      },
    };
  }

  /**
   * Make the check that runs before each statement: is the warehouse running?
   *
   * A statement starts a stopped warehouse, and a running warehouse costs
   * money. Thus the check asks the user first. The setting
   * "dbxNotebook.tableViz.confirmComputeStart" turns the question off.
   *
   * Many statements can start at the same time. They share one check and
   * one question.
   */
  private startGuard(compute: Compute, workspace: WorkspaceClient): (signal?: CancelSignal) => Promise<void> {
    let checkedAt = 0;
    let pending: Promise<void> | undefined;

    const check = async () => {
      let state: string;
      try {
        state = (await workspace.getWarehouse(compute.id)).state;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          throw new ProfilerError(`The warehouse "${compute.name}" does not exist now.`, {
            nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a different one.',
            raw: e.message,
          });
        }
        throw e;
      }
      this.setComputeState(state);
      if (state === 'DELETED' || state === 'DELETING') {
        throw new ProfilerError(`The warehouse "${compute.name}" is deleted.`, {
          nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a different one.',
        });
      }
      if (state !== 'RUNNING' && state !== 'STARTING' && this.settings().confirmComputeStart) {
        const start = 'Start the Warehouse';
        const answer = await vscode.window.showWarningMessage(
          `The warehouse "${compute.name}" is stopped.`,
          { modal: true, detail: 'A query starts the warehouse. A warehouse that runs costs money. Do you want to start it?' },
          start
        );
        if (answer !== start) {
          throw new ProfilerError(`The warehouse "${compute.name}" is stopped, and you did not permit the extension to start it.`, {
            nextStep: 'Click "Refresh" to get the question again, or select a different warehouse.',
          });
        }
      }
      checkedAt = Date.now();
    };

    return () => {
      if (Date.now() - checkedAt < STATE_CHECK_MS) return Promise.resolve();
      pending ??= check().finally(() => {
        pending = undefined;
      });
      return pending;
    };
  }
}
