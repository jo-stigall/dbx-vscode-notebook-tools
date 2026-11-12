/**
 * The rules for all-purpose clusters: which clusters the feature can use, and how to connect to one.
 *
 * A cluster is different from a SQL warehouse in three ways. It has a
 * Databricks Runtime version, which decides the SQL that it accepts. It has
 * an access mode, which decides if it can read Unity Catalog. And the SQL
 * driver connects to it through an "HTTP path" that contains the ID of the
 * workspace.
 */

/** What the Clusters API tells about a cluster. */
export interface ClusterInfo {
  id: string;
  name: string;
  /** PENDING, RUNNING, RESTARTING, RESIZING, TERMINATING, TERMINATED, ERROR or UNKNOWN. */
  state: string;
  /** The runtime, as the API writes it. Example: '15.4.x-scala2.12'. */
  sparkVersion?: string;
  /** The access mode, as the API writes it (`data_security_mode`). Example: 'SINGLE_USER'. */
  accessMode?: string;
}

/**
 * The oldest Databricks Runtime that the feature accepts.
 *
 * The statements of the feature need two things. `IDENTIFIER()` needs
 * runtime 13.3 LTS. Named parameters through the SQL driver need a newer
 * protocol, which runtime 14.2 has.
 *
 * No test confirmed the number 14.2. The author remembers it from the docs
 * of the Databricks SQL connector, but did not find a page that states it.
 * A test on a real cluster must confirm it.
 */
export const MIN_RUNTIME = { major: 14, minor: 2 };

/**
 * Read the version of a Databricks Runtime.
 *
 * @returns The two numbers of the version, or undefined if the text does not start with a version, as for a custom image.
 *
 * @example
 * parseRuntime('15.4.x-scala2.12')          // { major: 15, minor: 4 }
 * parseRuntime('13.3.x-photon-scala2.12')   // { major: 13, minor: 3 }
 * parseRuntime('custom:my-image')           // undefined
 */
export function parseRuntime(sparkVersion: string | undefined): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(sparkVersion ?? '');
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

/** The access modes that can read Unity Catalog, and their names in the Databricks UI. */
const UNITY_CATALOG_MODES: Record<string, string> = {
  SINGLE_USER: 'dedicated',
  USER_ISOLATION: 'standard',
  DATA_SECURITY_MODE_DEDICATED: 'dedicated',
  DATA_SECURITY_MODE_STANDARD: 'standard',
  DATA_SECURITY_MODE_AUTO: 'automatic',
};

/**
 * Get the name of the access mode of a cluster, for a person to read.
 *
 * For a mode that can read Unity Catalog, the function returns the name in
 * the Databricks UI. For each other mode, it writes the API name in lower
 * case.
 *
 * @example
 * accessModeLabel('SINGLE_USER')              // 'dedicated'
 * accessModeLabel('NONE')                     // 'no isolation shared'
 * accessModeLabel('LEGACY_TABLE_ACL')         // 'legacy table acl'
 */
export function accessModeLabel(accessMode: string | undefined): string {
  if (!accessMode || accessMode === 'NONE') return 'no isolation shared';
  return UNITY_CATALOG_MODES[accessMode] ?? accessMode.toLowerCase().replace(/_/g, ' ');
}

/**
 * Tell why the feature cannot use a cluster. Returns undefined if it can.
 *
 * @example
 * clusterProblem({ id: 'c', name: 'c', state: 'RUNNING', sparkVersion: '15.4.x-scala2.12', accessMode: 'SINGLE_USER' })
 * // undefined
 * clusterProblem({ id: 'c', name: 'c', state: 'RUNNING', sparkVersion: '15.4.x-scala2.12', accessMode: 'NONE' })
 * // 'Its access mode is "no isolation shared", which cannot read Unity Catalog. Use a cluster with the access mode "standard" or "dedicated".'
 * clusterProblem({ id: 'c', name: 'c', state: 'RUNNING', sparkVersion: '13.3.x-scala2.12', accessMode: 'SINGLE_USER' })
 * // 'It has Databricks Runtime 13.3. The feature needs 14.2 or later.'
 *
 * @returns One or two sentences for the user. The function does not look at `state`: a stopped cluster has no problem.
 */
export function clusterProblem(cluster: ClusterInfo): string | undefined {
  if (!cluster.accessMode || !(cluster.accessMode in UNITY_CATALOG_MODES)) {
    return `Its access mode is "${accessModeLabel(cluster.accessMode)}", which cannot read Unity Catalog. Use a cluster with the access mode "standard" or "dedicated".`;
  }
  const runtime = parseRuntime(cluster.sparkVersion);
  // The function permits a runtime that it cannot read (a custom image). The first query shows if it works.
  if (runtime && (runtime.major < MIN_RUNTIME.major || (runtime.major === MIN_RUNTIME.major && runtime.minor < MIN_RUNTIME.minor))) {
    return `It has Databricks Runtime ${runtime.major}.${runtime.minor}. The feature needs ${MIN_RUNTIME.major}.${MIN_RUNTIME.minor} or later.`;
  }
  return undefined;
}

/**
 * Make the HTTP path of a cluster, which the SQL driver needs.
 *
 * The cluster page in Databricks shows the same text below "JDBC/ODBC".
 *
 * @example
 * clusterHttpPath('1234567890123456', '0101-123456-abcdefgh')   // 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh'
 */
export function clusterHttpPath(workspaceId: string, clusterId: string): string {
  return `sql/protocolv1/o/${workspaceId}/${clusterId}`;
}

/**
 * Find the ID of the workspace in its URL. Only Azure Databricks URLs contain it.
 *
 * @example
 * workspaceIdFromHost('https://adb-1234567890123456.7.azuredatabricks.net')   // '1234567890123456'
 * workspaceIdFromHost('https://dbc-a1b2c3d4-e5f6.cloud.databricks.com')       // undefined
 */
export function workspaceIdFromHost(host: string): string | undefined {
  return /^(?:https?:\/\/)?adb-(\d+)\./.exec(host)?.[1];
}

/**
 * Tell if a Node.js version can run the SQL driver.
 *
 * Version 3 of the driver needs a Node.js that has a security fix: 22.23.4
 * or later of line 22, 24.22.1 or later of line 24, or 26.12.1 and later.
 * VS Code contains its own Node.js, so an old VS Code cannot use a cluster.
 *
 * @example
 * driverSupportsNode('24.22.1')   // true
 * driverSupportsNode('20.9.0')    // false
 * driverSupportsNode('23.5.0')    // false: line 23 does not have the fix
 */
export function driverSupportsNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => parseInt(part, 10));
  const atLeast = (m: number, p: number) => minor > m || (minor === m && patch >= p);
  if (major === 22) return atLeast(23, 4);
  if (major === 24) return atLeast(22, 1);
  if (major === 26) return atLeast(12, 1);
  return major > 26;
}
