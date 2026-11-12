/** The command "Select Profile and Compute for Tables": two lists, first the profile, then the SQL warehouse or the cluster. */
import * as vscode from 'vscode';
import { accessModeLabel, clusterProblem, driverSupportsNode, parseRuntime, type ClusterInfo } from '../core/clusters.ts';
import { DEMO_PROFILE, TOKEN_PROFILE_PREFIX, WORKSPACE_PROFILE, type Compute, type HostConnection, type Session } from './session.ts';
import type { Warehouse } from './workspace.ts';

interface ProfileItem extends vscode.QuickPickItem {
  /** The profile name. Not set for the item "Type a workspace URL and a token…". */
  profile?: string;
}

interface ComputeItem extends vscode.QuickPickItem {
  /** Not set for a line that only separates two groups. */
  compute?: Compute;
  /** Why the compute cannot be used. Not set if it can. */
  problem?: string;
}

/** Ask for a workspace URL and a personal access token, and keep the token in the secret store. Returns the profile name. */
async function typeToken(conn: HostConnection): Promise<string | undefined> {
  const host = await vscode.window.showInputBox({
    title: 'Workspace URL',
    prompt: 'Type the URL of your Databricks workspace',
    placeHolder: 'https://adb-1234567890123456.7.azuredatabricks.net',
    ignoreFocusOut: true,
    validateInput: (value) => (/^(https:\/\/)?[\w.-]+\.[a-z]{2,}(:\d+)?\/?$/i.test(value.trim()) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value.trim()) ? undefined : 'Type a URL that starts with https://'),
  });
  if (!host) return undefined;
  const token = await vscode.window.showInputBox({
    title: 'Personal access token',
    prompt: 'Type a personal access token for this workspace. VS Code keeps it in its secret store.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Type the token'),
  });
  if (!token) return undefined;
  return conn.storeToken(host.trim(), token.trim());
}

/**
 * Let the user select a profile, then a SQL warehouse or a cluster of that profile.
 *
 * The second list shows the state of each warehouse and cluster. A cluster
 * that cannot read Unity Catalog, or that has an old runtime, is in the
 * list with the reason, but the user cannot select it. To read the list,
 * the function calls the REST API. It starts nothing.
 *
 * @returns true if the user selected a profile. false if the user closed a list.
 */
export async function selectProfileAndCompute(session: Session, conn: HostConnection): Promise<boolean> {
  const current = session.profile;
  const mark = (profile: string) => (profile === current ? ' (selected)' : '');
  const items: ProfileItem[] = [];

  const workspaceHost = session.hostOf(WORKSPACE_PROFILE);
  if (workspaceHost) {
    items.push({ label: '$(notebook) Notebook connection' + mark(WORKSPACE_PROFILE), description: workspaceHost, detail: 'The workspace that the notebooks of this project use', profile: WORKSPACE_PROFILE });
  }
  for (const p of conn.listProfiles()) {
    items.push({ label: `$(account) ${p.name}` + mark(p.name), description: p.host, detail: p.auth === 'token' ? 'Profile in ~/.databrickscfg, with a token' : `Profile in ~/.databrickscfg, login with "databricks auth login"`, profile: p.name });
  }
  for (const host of conn.storedHosts()) {
    const profile = TOKEN_PROFILE_PREFIX + host;
    items.push({ label: `$(key) ${host.replace(/^https?:\/\//, '')}` + mark(profile), description: host, detail: 'Token in the secret store of VS Code', profile });
  }
  items.push({ label: '$(beaker) Demo' + mark(DEMO_PROFILE), description: 'demo.shop.orders_2025, demo.shop.orders_2026', detail: 'Two demo tables. No workspace and no login.', profile: DEMO_PROFILE });
  items.push({ label: '$(add) Type a workspace URL and a token…', detail: 'For a workspace that has no profile in ~/.databrickscfg' });

  const picked = await vscode.window.showQuickPick(items, { title: 'Profile for tables (1/2)', placeHolder: 'Select the Databricks login', matchOnDescription: true });
  if (!picked) return false;
  const profile = picked.profile ?? (await typeToken(conn));
  if (!profile) return false;
  if (profile === DEMO_PROFILE) {
    await session.select(profile);
    return true;
  }

  // The warehouses and the clusters of the profile. These requests also show if the login works.
  const workspace = session.workspace(profile);
  let warehouses: Warehouse[];
  let clusters: ClusterInfo[];
  try {
    [warehouses, clusters] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading the warehouses and clusters of ${session.label(profile)}…` },
      // A user who cannot list clusters can still use a warehouse.
      () => Promise.all([workspace.listWarehouses(), workspace.listClusters().catch(() => [])])
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not read the SQL warehouses of ${session.label(profile)}. ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  const selected = session.compute(profile)?.id;
  const mine = (id: string) => (id === selected ? ' (selected)' : '');
  // Running compute first: a query on it starts at once and starts nothing.
  const runningFirst = <T extends { state: string; name: string }>(list: T[]) =>
    [...list].sort((a, b) => Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING') || a.name.localeCompare(b.name));
  const oldNode = driverSupportsNode(process.versions.node) ? undefined : `This VS Code contains Node.js ${process.versions.node}. The SQL driver for clusters needs a newer Node.js. Update VS Code.`;

  const computeItems: ComputeItem[] = [];
  const usableWarehouses = runningFirst(warehouses.filter((w) => w.state !== 'DELETED' && w.state !== 'DELETING'));
  if (usableWarehouses.length) computeItems.push({ label: 'SQL warehouses', kind: vscode.QuickPickItemKind.Separator });
  for (const w of usableWarehouses) {
    computeItems.push({
      label: `$(database) ${w.name}` + mine(w.id),
      description: [w.state, w.size].filter(Boolean).join(' · '),
      compute: { kind: 'warehouse', id: w.id, name: w.name },
    });
  }
  if (clusters.length) computeItems.push({ label: 'All-purpose clusters', kind: vscode.QuickPickItemKind.Separator });
  for (const c of runningFirst(clusters)) {
    const runtime = parseRuntime(c.sparkVersion);
    const facts = [c.state, runtime ? `Runtime ${runtime.major}.${runtime.minor}` : c.sparkVersion, accessModeLabel(c.accessMode)].filter(Boolean).join(' · ');
    const problem = oldNode ?? clusterProblem(c);
    // VS Code cannot show a line of a list as "off". A cluster that cannot be used has a different icon and tells the reason.
    computeItems.push({
      label: `${problem ? '$(circle-slash)' : '$(server)'} ${c.name}` + mine(c.id),
      description: problem ? `Cannot be used · ${facts}` : facts,
      detail: problem,
      compute: { kind: 'cluster', id: c.id, name: c.name },
      problem,
    });
  }
  if (!computeItems.some((item) => item.compute && !item.problem)) {
    void vscode.window.showWarningMessage(`${session.label(profile)} has no SQL warehouse or cluster that you can use. Ask an administrator for the "Can use" permission on a warehouse.`);
    return false;
  }

  for (;;) {
    const picked = await vscode.window.showQuickPick(computeItems, { title: 'Compute for tables (2/2)', placeHolder: 'Select the SQL warehouse or the cluster that runs the queries', matchOnDescription: true });
    if (!picked?.compute) return false;
    if (picked.problem) {
      await vscode.window.showWarningMessage(`The cluster "${picked.compute.name}" cannot be used.`, { modal: true, detail: picked.problem });
      continue;
    }
    await session.select(profile, picked.compute);
    session.setComputeState((picked.compute.kind === 'cluster' ? clusters : warehouses).find((c) => c.id === picked.compute?.id)?.state);
    return true;
  }
}
