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
import { clusterHttpPath, clusterProblem, driverSupportsNode, workspaceIdFromHost } from '../core/clusters.ts';
import { Limiter } from '../core/limiter.ts';
import { ProfilerError, type CancelSignal, type Profiler } from '../core/profiler.ts';
import type { QueryRunner } from '../core/runner.ts';
import { DemoProfiler } from '../demo/demoProfiler.ts';
import { ClusterRunner, type DriverModule } from './clusterRunner.ts';
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

/** The compute that runs the queries of a profile: a SQL warehouse or an all-purpose cluster. */
export interface Compute {
  kind: 'warehouse' | 'cluster';
  id: string;
  name: string;
}

/** What VS Code stores: the selected profile, and the compute that the user selected for each profile. */
interface Stored {
  profile?: string;
  compute?: Record<string, Compute>;
}

const SELECTION_KEY = 'dbxNotebook.tableViz.selection';
/** The start of the name under which VS Code stores an HTTP path that the user typed. The cluster ID follows. */
const HTTP_PATH_KEY = 'dbxNotebook.tableViz.httpPath:';
/** How long the session waits for a cluster to start, in milliseconds. */
const CLUSTER_START_MS = 20 * 60_000;
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
  /** Workspace URL -> the ID of the workspace, from the answers of the REST API. */
  private readonly workspaceIds = new Map<string, string>();
  /** Functions that close the connections of the cluster runners. */
  private closers: (() => Promise<void>)[] = [];
  /**
   * Loads the SQL driver for clusters. The driver is a separate file
   * (dist/tableViz/driver.js) that the extension loads only for a cluster.
   * A test can put a fake driver here.
   */
  loadDriver: () => DriverModule | Promise<DriverModule> = () => require('./driver.js') as DriverModule;

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
      // 0 means automatic: 4 on a warehouse, and 2 on a cluster, which notebooks and jobs use at the same time.
      maxConcurrentQueries: positive('maxConcurrentQueries', 0),
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
    this.reset();
    this.computeState = undefined;
    this.changed.fire();
  }

  /** Forget all profilers and their caches, and close the connections to clusters. */
  private reset(): void {
    this.profilers.clear();
    const closers = this.closers;
    this.closers = [];
    closers.forEach((close) => void close().catch(() => {}));
  }

  /** Close the connections to clusters. The extension calls this function when it stops. */
  dispose(): void {
    this.reset();
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
      onWorkspaceId: (id) => this.workspaceIds.set(this.hostOf(profile), id),
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
      throw new ProfilerError(`No SQL warehouse or cluster is selected for the profile "${this.label(profile)}".`, {
        nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select one.',
      });
    }

    const http = this.http(profile);
    const workspace = new RestWorkspaceClient(http);
    const tags = { feature: 'table-viz' };
    const timeoutSeconds = () => this.settings().queryTimeoutSeconds;
    let runner: QueryRunner;
    if (compute.kind === 'cluster') {
      if (!driverSupportsNode(process.versions.node)) {
        throw new ProfilerError(`This VS Code contains Node.js ${process.versions.node}. The SQL driver for clusters needs a newer Node.js.`, {
          nextStep: 'Update VS Code, or select a SQL warehouse with "Databricks Notebook: Select Profile and Compute for Tables".',
        });
      }
      const cluster = new ClusterRunner({
        loadDriver: () => this.loadDriver(),
        host: () => host,
        httpPath: () => this.httpPath(host, compute),
        token: (fresh) => this.conn.getToken(this.folder, { profile, fresh }),
        timeoutSeconds,
        tags,
        log: (message) => this.log.debug(`tableViz: driver: ${message}`),
      });
      this.closers.push(() => cluster.close());
      runner = cluster;
    } else {
      runner = new StatementExecutionRunner({ http, warehouseId: compute.id, timeoutSeconds, tags });
    }
    const what = compute.kind === 'cluster' ? 'cluster' : 'warehouse';
    const sql = new SqlProfiler({
      runner: this.logged(runner),
      getTable: (table) => workspace.getTable(table),
      limiter: new Limiter(() => this.settings().maxConcurrentQueries || (compute.kind === 'cluster' ? 2 : 4)),
      describe: () => ({ timeoutSeconds: timeoutSeconds(), compute: `The ${what} "${compute.name}"`, host }),
      beforeQuery: this.shared(compute.kind === 'cluster' ? () => this.checkCluster(compute, workspace) : () => this.checkWarehouse(compute, workspace)),
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
   * Make the function that runs a check before each statement.
   *
   * Many statements can start at the same time. They share one check and
   * one question to the user. After a check that passed, the next check
   * runs two minutes later at the earliest.
   */
  private shared(check: () => Promise<void>): (signal?: CancelSignal) => Promise<void> {
    let checkedAt = 0;
    let pending: Promise<void> | undefined;
    return () => {
      if (Date.now() - checkedAt < STATE_CHECK_MS) return Promise.resolve();
      pending ??= check()
        .then(() => {
          checkedAt = Date.now();
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    };
  }

  /** Ask the user before a query starts stopped compute. Returns true if the user permits it, or if the setting turns the question off. */
  private async mayStart(message: string, detail: string, button: string): Promise<boolean> {
    if (!this.settings().confirmComputeStart) return true;
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  private goneError(compute: Compute, raw?: string): ProfilerError {
    return new ProfilerError(`The ${compute.kind} "${compute.name}" does not exist now.`, {
      nextStep: 'Run "Databricks Notebook: Select Profile and Compute for Tables" and select a different one.',
      raw,
    });
  }

  /**
   * The check before a statement on a SQL warehouse: is the warehouse running?
   *
   * A statement starts a stopped warehouse, and a warehouse that runs costs
   * money. Thus the check asks the user first. The setting
   * "dbxNotebook.tableViz.confirmComputeStart" turns the question off.
   */
  private async checkWarehouse(compute: Compute, workspace: WorkspaceClient): Promise<void> {
    let state: string;
    try {
      state = (await workspace.getWarehouse(compute.id)).state;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw this.goneError(compute, e.message);
      throw e;
    }
    this.setComputeState(state);
    if (state === 'DELETED' || state === 'DELETING') throw this.goneError(compute);
    if (state === 'RUNNING' || state === 'STARTING') return;
    const permitted = await this.mayStart(
      `The warehouse "${compute.name}" is stopped.`,
      'A query starts the warehouse. A warehouse that runs costs money. Do you want to start it?',
      'Start the Warehouse'
    );
    if (!permitted) {
      throw new ProfilerError(`The warehouse "${compute.name}" is stopped, and you did not permit the extension to start it.`, {
        nextStep: 'Click "Refresh" to get the question again, or select a different warehouse.',
      });
    }
  }

  /**
   * The check before a statement on a cluster.
   *
   * 1. The cluster must be able to read Unity Catalog and must have a new enough runtime.
   * 2. If the cluster is stopped, ask the user, then start it and wait until it runs.
   *    A connection to a stopped cluster starts it without a question, so the
   *    check must come before the connection.
   */
  private async checkCluster(compute: Compute, workspace: WorkspaceClient): Promise<void> {
    let cluster;
    try {
      cluster = await workspace.getCluster(compute.id);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) throw this.goneError(compute, e.message);
      throw e;
    }
    this.setComputeState(cluster.state);
    const problem = clusterProblem(cluster);
    if (problem) {
      throw new ProfilerError(`The cluster "${compute.name}" cannot run the queries of this feature.`, {
        nextStep: `${problem} Run "Databricks Notebook: Select Profile and Compute for Tables" to select a different one.`,
      });
    }
    if (cluster.state === 'RUNNING' || cluster.state === 'RESIZING') return;
    if (cluster.state === 'TERMINATING') {
      throw new ProfilerError(`The cluster "${compute.name}" is stopping now.`, { nextStep: 'Wait a minute, then click "Refresh".' });
    }
    if (cluster.state === 'TERMINATED') {
      const permitted = await this.mayStart(
        `The cluster "${compute.name}" is stopped.`,
        'A cluster can take several minutes to start, and a cluster that runs costs money. Do you want to start it?',
        'Start the Cluster'
      );
      if (!permitted) {
        throw new ProfilerError(`The cluster "${compute.name}" is stopped, and you did not permit the extension to start it.`, {
          nextStep: 'Click "Refresh" to get the question again, or select a different cluster or a SQL warehouse.',
        });
      }
      await workspace.startCluster(compute.id);
    } else if (cluster.state !== 'PENDING' && cluster.state !== 'RESTARTING') {
      throw new ProfilerError(`The cluster "${compute.name}" has the state ${cluster.state}.`, { nextStep: 'Open the cluster in Databricks to see what is wrong.' });
    }

    // Wait until the cluster runs. The user can stop the wait.
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting the cluster "${compute.name}"…`, cancellable: true },
      async (_progress, cancel) => {
        const end = Date.now() + CLUSTER_START_MS;
        for (;;) {
          const state = (await workspace.getCluster(compute.id)).state;
          this.setComputeState(state);
          if (state === 'RUNNING') return;
          if (state === 'TERMINATED' || state === 'TERMINATING' || state === 'ERROR') {
            throw new ProfilerError(`The cluster "${compute.name}" did not start. Its state is ${state}.`, { nextStep: 'Open the cluster in Databricks to see why.' });
          }
          if (cancel.isCancellationRequested) {
            throw new ProfilerError(`You stopped the wait for the cluster "${compute.name}".`, { nextStep: 'The cluster continues to start. Click "Refresh" when it runs.' });
          }
          if (Date.now() > end) {
            throw new ProfilerError(`The cluster "${compute.name}" did not start in 20 minutes.`, { nextStep: 'Open the cluster in Databricks to see why.' });
          }
          await new Promise((resolve) => setTimeout(resolve, this.clusterPollMs));
        }
      }
    );
  }

  /** The time between two checks of a cluster that starts, in milliseconds. A test can make it shorter. */
  clusterPollMs = 10_000;

  /**
   * Find the HTTP path of a cluster, which the SQL driver needs.
   *
   * The path contains the ID of the workspace. The session knows the ID
   * from the answers of the REST API, or from an Azure workspace URL. If it
   * knows neither, it asks the user for the path one time and stores it.
   */
  private async httpPath(host: string, compute: Compute): Promise<string> {
    const typed = this.context.workspaceState.get<string>(HTTP_PATH_KEY + compute.id);
    if (typed) return typed;
    const workspaceId = this.workspaceIds.get(host) ?? workspaceIdFromHost(host);
    if (workspaceId) return clusterHttpPath(workspaceId, compute.id);
    const answer = await vscode.window.showInputBox({
      title: `HTTP path of the cluster "${compute.name}"`,
      prompt: 'The extension could not find the ID of the workspace. Open the cluster in Databricks, open "Advanced options", then "JDBC/ODBC", and paste the HTTP Path here.',
      placeHolder: 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh',
      ignoreFocusOut: true,
      validateInput: (value) => (/^\/?sql\/protocolv1\/o\/\d+\/[\w-]+$/.test(value.trim()) ? undefined : 'The path has the form sql/protocolv1/o/<workspace ID>/<cluster ID>'),
    });
    if (!answer) {
      throw new ProfilerError(`The HTTP path of the cluster "${compute.name}" is not known.`, { nextStep: 'Click "Refresh" to type the path, or select a SQL warehouse.' });
    }
    const path = answer.trim().replace(/^\//, '');
    await this.context.workspaceState.update(HTTP_PATH_KEY + compute.id, path);
    return path;
  }
}
