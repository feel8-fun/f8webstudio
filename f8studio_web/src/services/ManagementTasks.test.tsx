import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ManagementJob } from '../api/contracts.gen';
import { cancelManagementJob, clearCompletedManagementJobs, fetchManagementJobLogs } from '../api/client';
import { ManagementTasks } from './ManagementTasks';

vi.mock('../api/client', () => ({ cancelManagementJob: vi.fn(), clearCompletedManagementJobs: vi.fn(), fetchManagementJobLogs: vi.fn(), fetchManagementJobs: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });

const completed: ManagementJob = {
  jobId: 'done', request: { action: 'install-extension', extensionId: 'example', environmentId: null, package: null, location: null, sha256: null },
  state: 'succeeded', createdAt: 1, startedAt: 2, finishedAt: 5,
  detail: 'A long installation message', cancellable: false, cancelRequested: false,
};

it('loads logs on demand and lets users close them', async () => {
  vi.mocked(fetchManagementJobLogs).mockResolvedValue({ log: 'Detailed installation log' });
  render(<ManagementTasks jobs={[completed]} error="" />);
  expect(fetchManagementJobLogs).not.toHaveBeenCalled();
  expect(screen.queryByText(completed.detail)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tasks · 0 active' }));
  fireEvent.click(screen.getByRole('button', { name: 'Task logs' }));
  expect(await screen.findByText('Detailed installation log')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close logs' }));
  expect(screen.queryByLabelText('Task logs')).not.toBeInTheDocument();
});

it('clears completed jobs on the platform without cancelling or hiding active jobs', async () => {
  const running: ManagementJob = { ...completed, jobId: 'live', state: 'running', finishedAt: null, cancellable: true };
  const jobs = [completed, running];
  vi.mocked(clearCompletedManagementJobs).mockResolvedValue([running]);
  const first = render(<ManagementTasks jobs={jobs} error="" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tasks · 1 active' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete completed' }));
  await waitFor(() => expect(screen.getByText('Maintenance tasks · 1')).toBeInTheDocument());
  expect(clearCompletedManagementJobs).toHaveBeenCalledWith(['done']);
  expect(cancelManagementJob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close tasks' }));
  expect(screen.queryByRole('region', { name: 'Maintenance tasks' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tasks · 1 active' }));
  first.unmount();
  render(<ManagementTasks jobs={jobs} error="" />);
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tasks · 1 active' }));
  expect(screen.getByRole('button', { name: 'Cancel task' })).toBeVisible();
});

it('keeps records visible and reports a failed clear request', async () => {
  vi.mocked(clearCompletedManagementJobs).mockRejectedValue(new Error('Platform storage unavailable'));
  render(<ManagementTasks jobs={[completed]} error="" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tasks · 0 active' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete record' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Platform storage unavailable');
  expect(screen.getByText('succeeded')).toBeVisible();
  expect(localStorage.getItem('f8-maintenance-dismissed')).toBeNull();
  expect(screen.getByRole('button', { name: 'Delete record' })).toBeEnabled();
});
