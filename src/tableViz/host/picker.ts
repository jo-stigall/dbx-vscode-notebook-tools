/** The command "Select Profile and Compute for Tables": two lists, first the profile, then the SQL warehouse. */
import * as vscode from 'vscode';
import { DEMO_PROFILE, TOKEN_PROFILE_PREFIX, WORKSPACE_PROFILE, type Compute, type HostConnection, type Session } from './session.ts';

interface ProfileItem extends vscode.QuickPickItem {
  /** The profile name. Not set for the item "Type a workspace URL and a token…". */
  profile?: string;
}

interface ComputeItem extends vscode.QuickPickItem {
  compute: Compute;
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
 * Let the user select a profile, then a SQL warehouse of that profile.
 *
 * The list of warehouses shows the state and the size of each one. To read
 * that list, the function calls the REST API. It does not start a warehouse.
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

  // The warehouses of the profile. This request also shows if the login works.
  let warehouses;
  try {
    warehouses = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading the SQL warehouses of ${session.label(profile)}…` }, () =>
      session.workspace(profile).listWarehouses()
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not read the SQL warehouses of ${session.label(profile)}. ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const selected = session.compute(profile)?.id;
  const computeItems: ComputeItem[] = warehouses
    .filter((w) => w.state !== 'DELETED' && w.state !== 'DELETING')
    // Running warehouses first: a query on them starts at once and starts nothing.
    .sort((a, b) => Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING') || a.name.localeCompare(b.name))
    .map((w) => ({
      label: `$(database) ${w.name}` + (w.id === selected ? ' (selected)' : ''),
      description: [w.state, w.size].filter(Boolean).join(' · '),
      detail: 'SQL warehouse',
      compute: { kind: 'warehouse', id: w.id, name: w.name },
    }));
  if (computeItems.length === 0) {
    void vscode.window.showWarningMessage(`${session.label(profile)} has no SQL warehouse that you can use. Ask an administrator for the "Can use" permission on a warehouse.`);
    return false;
  }
  const compute = await vscode.window.showQuickPick(computeItems, { title: 'Compute for tables (2/2)', placeHolder: 'Select the SQL warehouse that runs the queries', matchOnDescription: true });
  if (!compute) return false;
  await session.select(profile, compute.compute);
  session.setComputeState(warehouses.find((w) => w.id === compute.compute.id)?.state);
  return true;
}
