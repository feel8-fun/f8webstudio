import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectRecord } from '../api/contracts';
import type { StudioEvent } from '../api/eventStream';
import { useGraphProject } from './useGraphProject';

const api = vi.hoisted(() => ({
  fetchProjects: vi.fn(), fetchProject: vi.fn(), fetchLatestDeployment: vi.fn(), fetchCatalog: vi.fn(),
  patchProject: vi.fn(), changeHistory: vi.fn(), createProject: vi.fn(), deleteProject: vi.fn(), updateProject: vi.fn(),
  exportProjectGraph: vi.fn(), importProjectGraph: vi.fn(), refreshCatalog: vi.fn(),
}));
const events = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../api/client', () => api);
vi.mock('../api/eventStream', () => ({ studioEvents: events }));

const initial: ProjectRecord = {
  projectId: 'p', name: 'Project', description: '', createdAt: '', updatedAt: '',
  document: { schemaVersion: 'f8studio-document/3', projectId: 'p', graphId: 'p', graphRevision: 0,
    layoutRevision: 0, nodes: [], edges: [], layout: [] },
};
const reset = vi.fn();
const report = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.fetchProjects.mockResolvedValue([initial]);
  api.fetchProject.mockResolvedValue(initial);
  api.fetchLatestDeployment.mockResolvedValue(null);
  api.fetchCatalog.mockResolvedValue({ services: [], operators: [] });
  events.subscribe.mockReturnValue(events.unsubscribe);
});
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const created: ProjectRecord = {
  ...initial, projectId: 'new', name: 'New project',
  document: { ...initial.document, projectId: 'new', graphId: 'new' },
};

test('creating a project owns selection even when the initial project list arrives later', async () => {
  const listing = deferred<readonly ProjectRecord[]>();
  api.fetchProjects.mockReturnValueOnce(listing.promise).mockResolvedValue([initial, created]);
  api.createProject.mockResolvedValue(created);
  const { result } = renderHook(() => useGraphProject(reset, report));
  await act(async () => { await result.current.addProject(); });
  await act(async () => { listing.resolve([initial]); });
  expect(result.current.selectedProjectId).toBe('new');
  expect(result.current.project).toEqual(created);
  expect(result.current.projects).toEqual([initial, created]);
  expect(result.current.catalog).not.toBeNull();
  expect(api.fetchProject).not.toHaveBeenCalled();
});

test('an initial project response cannot replace a newly created project', async () => {
  const loading = deferred<ProjectRecord>();
  api.fetchProject.mockReturnValueOnce(loading.promise);
  api.createProject.mockResolvedValue(created);
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(api.fetchProject).toHaveBeenCalledWith('p', expect.any(AbortSignal)));
  await act(async () => { await result.current.addProject(); });
  await act(async () => { loading.resolve(initial); });
  expect(result.current.selectedProjectId).toBe('new');
  expect(result.current.project).toEqual(created);
  expect(result.current.busy).toBe(false);
});

test('superseded selections and background reloads cannot overwrite the latest selection or its busy state', async () => {
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(initial));
  const staleReload = deferred<ProjectRecord>();
  const failedSelection = deferred<ProjectRecord>();
  const latestSelection = deferred<ProjectRecord>();
  api.fetchProject.mockReturnValueOnce(staleReload.promise)
    .mockReturnValueOnce(failedSelection.promise).mockReturnValueOnce(latestSelection.promise);
  let reloading!: Promise<ProjectRecord>;
  let failed!: Promise<void>;
  let latest!: Promise<void>;
  act(() => {
    reloading = result.current.reloadProject('p');
    failed = result.current.selectProject('old');
    latest = result.current.selectProject('new');
  });
  await act(async () => {
    failedSelection.reject(new Error('old selection failed'));
    staleReload.resolve(initial);
    await Promise.all([failed, reloading]);
  });
  expect(result.current.selectedProjectId).toBe('new');
  expect(result.current.project).toBeNull();
  expect(result.current.busy).toBe(true);
  expect(result.current.error).toBeNull();
  await act(async () => { latestSelection.resolve(created); await latest; });
  expect(result.current.project).toEqual(created);
  expect(result.current.busy).toBe(false);
});

test('queued edits use the revision returned by the previous edit and clear saving', async () => {
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(initial));
  const revisions: number[] = [];
  api.patchProject.mockImplementation(async (_id, document: ProjectRecord['document']) => {
    revisions.push(document.graphRevision);
    return { document: { ...document, graphRevision: document.graphRevision + 1 }, runtimeErrors: [] };
  });
  await act(async () => {
    const edit = [{ op: 'deleteNode' as const, nodeId: 'missing' }];
    await Promise.all([result.current.commit(edit), result.current.commit(edit)]);
  });
  expect(revisions).toEqual([0, 1]);
  expect(result.current.project?.document.graphRevision).toBe(2);
  expect(result.current.saving).toBe(false);
});

test('failed edit reloads authoritative state and invalidates dependent edits', async () => {
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(initial));
  api.fetchProject.mockResolvedValue({ ...initial, document: { ...initial.document, graphRevision: 5 } });
  api.patchProject.mockRejectedValue(new Error('revision conflict'));
  await act(async () => {
    const edit = [{ op: 'deleteNode' as const, nodeId: 'missing' }];
    const outcomes = await Promise.allSettled([result.current.commit(edit), result.current.commit(edit)]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
  });
  expect(api.patchProject).toHaveBeenCalledTimes(1);
  expect(result.current.project?.document.graphRevision).toBe(5);
  expect(result.current.saving).toBe(false);
  expect(result.current.error).not.toBeNull();
});

test('applies saved configuration from the HTTP response without a broadcast even when runtime synchronization fails', async () => {
  const tick = { kind: 'operator' as const, nodeId: 'tick', name: 'Tick', serviceId: 'engine', serviceClass: 'f8.pyengine',
    operatorClass: 'f8.tick', enabled: true, ports: [], portIds: {}, stateValues: { tickMs: 100 },
    spec: { specKind: 'operator' as const, serviceClass: 'f8.pyengine', operatorClass: 'f8.tick', label: 'Tick' } };
  const record = { ...initial, document: { ...initial.document, nodes: [tick] } };
  api.fetchProject.mockResolvedValue(record);
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(record));
  api.patchProject.mockResolvedValue({ document: { ...record.document, graphRevision: 1,
    nodes: [{ ...tick, stateValues: { tickMs: 250 } }] }, graphChanged: true, runtimeErrors: ['service offline'] });
  await act(async () => { await result.current.commit([{ op: 'setNodeState', nodeId: 'tick', field: 'tickMs', value: 250 }]); });
  expect(result.current.project?.document.nodes[0]?.stateValues.tickMs).toBe(250);
  expect(result.current.error).toContain('Saved to project, but runtime sync failed');
  expect(result.current.saving).toBe(false);
});

test('late graph events cannot roll back a newer revision and unsubscribe on unmount', async () => {
  let receive: (event: StudioEvent) => void = () => {};
  events.subscribe.mockImplementation((listener: typeof receive) => { receive = listener; return events.unsubscribe; });
  const { result, unmount } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(initial));
  const send = (revision: number) => receive({
    type: 'graph.committed', scope: 'project:p', serverEpoch: 'test', sequence: revision, eventId: String(revision), timestamp: '',
    payload: { document: { ...initial.document, graphRevision: revision } },
  });
  act(() => { send(3); send(1); });
  expect(result.current.project?.document.graphRevision).toBe(3);
  unmount();
  expect(events.unsubscribe).toHaveBeenCalledTimes(1);
});

test('renaming preserves the description and newer graph events received during the request', async () => {
  let receive: (event: StudioEvent) => void = () => {};
  events.subscribe.mockImplementation((listener: typeof receive) => { receive = listener; return events.unsubscribe; });
  const record = { ...initial, description: 'Keep this description' };
  api.fetchProject.mockResolvedValue(record);
  const { result } = renderHook(() => useGraphProject(reset, report));
  await waitFor(() => expect(result.current.project).toEqual(record));
  const renamed = { ...record, name: '新版项目', updatedAt: '2026-10-08T12:00:00Z' };
  api.updateProject.mockImplementation(async () => {
    receive({ type: 'graph.committed', scope: 'project:p', serverEpoch: 'test', sequence: 1, eventId: '1', timestamp: '',
      payload: { document: { ...record.document, graphRevision: 3, layoutRevision: 2 } } });
    return renamed;
  });
  await act(async () => { expect(await result.current.renameProject('  新版项目  ')).toBe(true); });
  expect(api.updateProject).toHaveBeenCalledWith('p', { name: '新版项目', description: record.description });
  expect(result.current.project).toMatchObject({ name: '新版项目', description: record.description,
    document: { graphRevision: 3, layoutRevision: 2 } });
  expect(result.current.projects[0]?.name).toBe('新版项目');
  expect(result.current.busy).toBe(false);
  act(() => receive({ type: 'project.updated', scope: 'project:p', serverEpoch: 'test', sequence: 2, eventId: '2', timestamp: '',
    payload: { ...renamed, name: 'Renamed in another tab' } }));
  expect(result.current.project?.name).toBe('Renamed in another tab');
  expect(result.current.projects[0]?.name).toBe('Renamed in another tab');
  expect(result.current.project?.document.graphRevision).toBe(3);
});
