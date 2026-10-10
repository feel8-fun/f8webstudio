import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProjectRecord, ProjectVersion } from '../api/contracts';
import { ProjectSnapshots } from './ProjectSnapshots';

const api = vi.hoisted(() => ({ createProjectVersion: vi.fn(), deleteProjectVersion: vi.fn(), fetchProjectVersions: vi.fn(), restoreProjectVersion: vi.fn(), updateProjectVersion: vi.fn() }));
vi.mock('../api/client', () => api);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const project: ProjectRecord = { projectId: 'p', name: 'Graph', description: '', createdAt: '', updatedAt: '', document: {
  schemaVersion: 'f8studio-document/3', projectId: 'p', graphId: 'p', graphRevision: 4, layoutRevision: 2, nodes: [], edges: [], layout: [],
} };
const snapshot: ProjectVersion = { projectId: 'p', versionId: 's', name: 'Known good', description: 'Camera ready', createdAt: '2026-01-01T00:00:00Z', document: project.document };

test('creates a named checkpoint and edits its notes without sending graph contents', async () => {
  api.fetchProjectVersions.mockResolvedValue([]);
  api.createProjectVersion.mockResolvedValue(snapshot);
  const edited = { ...snapshot, name: 'Before demo', description: 'Validated timing' };
  api.updateProjectVersion.mockResolvedValue(edited);
  render(<ProjectSnapshots project={project} onRestored={vi.fn()}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save snapshot' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save snapshot' }));
  fireEvent.change(screen.getByLabelText('Snapshot name'), { target: { value: snapshot.name } });
  fireEvent.change(screen.getByLabelText('Snapshot notes'), { target: { value: snapshot.description } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('heading', { name: snapshot.name })).toBeInTheDocument();
  expect(api.createProjectVersion).toHaveBeenCalledWith('p', snapshot.name, snapshot.description);
  fireEvent.click(screen.getByRole('button', { name: `Edit ${snapshot.name}` }));
  fireEvent.change(screen.getByLabelText('Snapshot name'), { target: { value: edited.name } });
  fireEvent.change(screen.getByLabelText('Snapshot notes'), { target: { value: edited.description } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('heading', { name: edited.name })).toBeInTheDocument();
  expect(screen.getByText(edited.description)).toBeInTheDocument();
  expect(api.updateProjectVersion).toHaveBeenCalledWith('p', 's', edited.name, edited.description);
  expect(api.restoreProjectVersion).not.toHaveBeenCalled();
});

test('snapshot deletion requires confirmation and leaves the current graph alone', async () => {
  api.fetchProjectVersions.mockResolvedValue([snapshot]);
  api.deleteProjectVersion.mockResolvedValue(undefined);
  const restored = vi.fn();
  render(<ProjectSnapshots project={project} onRestored={restored}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Known good' }));
  expect(api.deleteProjectVersion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('heading', { name: snapshot.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Known good' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete snapshot' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: snapshot.name })).not.toBeInTheDocument());
  expect(api.deleteProjectVersion).toHaveBeenCalledWith('p', 's');
  expect(restored).not.toHaveBeenCalled();
});

test('restores only after confirmation and cannot replace another project after navigation', async () => {
  api.fetchProjectVersions.mockResolvedValue([snapshot]);
  let finish!: (record: ProjectRecord) => void;
  api.restoreProjectVersion.mockReturnValue(new Promise<ProjectRecord>((resolve) => { finish = resolve; }));
  const restored = vi.fn();
  const view = render(<ProjectSnapshots project={project} onRestored={restored}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Known good' }));
  expect(api.restoreProjectVersion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restore snapshot' }));
  expect(api.restoreProjectVersion).toHaveBeenCalledWith('p', 's');
  view.unmount();
  await act(async () => { finish(project); });
  expect(restored).not.toHaveBeenCalled();
});
