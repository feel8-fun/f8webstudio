import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { RuntimeEnvironments } from './RuntimeEnvironments';
import type { EnvironmentStatus } from '../api/contracts.gen';

const api = vi.hoisted(() => ({ cleanUnusedEnvironments: vi.fn(), prepareEnvironment: vi.fn(), cancelEnvironmentPreparation: vi.fn(),
  fetchEnvironmentDetail: vi.fn(), fetchRuntimeStorage: vi.fn(), removeEnvironment: vi.fn(), setRuntimeStorage: vi.fn() }));
vi.mock('../api/client', () => api);
const refresh = vi.fn().mockResolvedValue(undefined);
const usage = { logicalBytes: 1024, uniqueFileBytes: 1024, sharedLinkBytes: 512, exclusiveFileBytes: 512, allocatedBytes: 4096, exclusiveAllocatedBytes: 4096 };
const environment: EnvironmentStatus = { environmentId: 'base-id', name: 'extension-runtime', runtimeKind: 'workspace',
  source: 'package', revision: '1234', state: 'changed', detail: 'Definition changed; verify to update records.',
  ready: true, extensionIds: ['engine'], serviceClasses: ['f8.pyengine'], toolIds: ['diagnostics/verify'], canRemove: false };
const storage = { path: '/data/runtime-storage', cachePath: '/data/runtime-storage/package-cache', canChange: true,
  environmentUsage: usage, cacheUsage: usage, totalUsage: usage, unusedEnvironments: [] };

beforeEach(() => {
  api.fetchRuntimeStorage.mockResolvedValue(storage);
  api.fetchEnvironmentDetail.mockResolvedValue({ environmentId: 'base-id', name: 'extension-runtime', revision: 'abcd', manifest: '[workspace]',
    definitionPath: '/extension/pixi.toml', sourceEnvironment: 'runtime', storagePath: '/data/envs/extension', cachePath: '/data/package-cache',
    usage, packageInventory: 'installed', packages: [{ name: 'numpy', version: '2.0.0', manager: 'conda', build: 'build_0', platform: 'linux-64' }] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); refresh.mockResolvedValue(undefined); });

test('shows extension environments and has no creation or sharing controls', async () => {
  render(<RuntimeEnvironments environments={[environment]} extensions={[]} onRefresh={refresh} locked={false} />);
  expect(screen.getByRole('button', { name: 'extension-runtime' })).toBeInTheDocument();
  expect(screen.getByText('Definition changed')).toBeInTheDocument();
  expect(screen.getByText('f8.pyengine')).toBeInTheDocument();
  expect(screen.getByText('diagnostics/verify')).toBeInTheDocument();
  expect(screen.queryByText('Create developer environment')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Base environment')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Verify and update' }));
  expect(api.prepareEnvironment).toHaveBeenCalledWith('base-id');
  await screen.findByDisplayValue('/data/runtime-storage');
  expect(screen.queryByRole('button', { name: 'Clear package cache' })).not.toBeInTheDocument();
});

test('shows installed package versions and allocated storage', async () => {
  render(<RuntimeEnvironments environments={[environment]} extensions={[]} onRefresh={refresh} locked={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'extension-runtime' }));
  expect(await screen.findByRole('heading', { name: 'Installed packages (1)' })).toBeInTheDocument();
  expect(screen.getByText('numpy')).toBeInTheDocument();
  expect(screen.getByText('2.0.0')).toBeInTheDocument();
  expect(screen.getByText('/extension/pixi.toml')).toBeInTheDocument();
  expect(screen.getAllByText('Allocated file blocks').length).toBeGreaterThan(0);
});

test('releases unused files and prevents releasing referenced environments', async () => {
  api.fetchRuntimeStorage.mockResolvedValue({ ...storage, unusedEnvironments: [{ environmentId: 'pixi-old', path: '/data/runtimes/pixi-old', usage }] });
  render(<RuntimeEnvironments environments={[{ ...environment, runtimeKind: 'pixi' }]} extensions={[]} onRefresh={refresh} locked={false} />);
  expect(screen.getByRole('button', { name: 'Release extension-runtime' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'Release unused environment files' }));
  expect(await screen.findByText('Unused environment cleanup queued.')).toBeInTheDocument();
  expect(api.cleanUnusedEnvironments).toHaveBeenCalledOnce();
});

test('cancels preparation and exposes actionable errors', async () => {
  api.cancelEnvironmentPreparation.mockRejectedValue(new Error('Cannot stop installer'));
  render(<RuntimeEnvironments environments={[{ ...environment, state: 'preparing' }]} extensions={[]} onRefresh={refresh} locked={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel preparation' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot stop installer');
  expect(api.cancelEnvironmentPreparation).toHaveBeenCalledWith('base-id');
});

test('renders environment controls while storage measurement is still pending', async () => {
  let resolveStorage: (value: typeof storage) => void = () => { throw new Error('Storage request did not start'); };
  api.fetchRuntimeStorage.mockReturnValueOnce(new Promise<typeof storage>((resolve) => { resolveStorage = resolve; }));
  render(<RuntimeEnvironments environments={[environment]} extensions={[]} onRefresh={refresh} locked={false} />);
  expect(screen.getByRole('button', { name: 'extension-runtime' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Verify and update' })).toBeEnabled();
  expect(screen.getByText('Measuring storage usage…')).toBeInTheDocument();
  resolveStorage(storage);
  await screen.findByRole('button', { name: 'Refresh storage usage' });
  expect(screen.queryByText('Measuring storage usage…')).not.toBeInTheDocument();
});

test('explicit storage refresh requests a fresh measurement', async () => {
  render(<RuntimeEnvironments environments={[environment]} extensions={[]} onRefresh={refresh} locked={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh storage usage' }));
  expect(api.fetchRuntimeStorage.mock.calls[0]?.[1]).toBe(false);
  expect(api.fetchRuntimeStorage.mock.calls[1]?.[1]).toBe(true);
});
