import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudProvider } from '../library/CloudContext';
import { CloudBrowser } from '../library/CloudBrowser';
import { SettingsButton, SettingsProvider } from './StudioSettings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/cloud/status' ?
    { configured: false, registryId: '', user: null } : []))));
}
test('global Settings groups AI and Cloud and preserves edits when switching categories', async () => {
  setup();
  render(<CloudProvider><SettingsProvider><SettingsButton/></SettingsProvider></CloudProvider>);
  const button = screen.getByRole('button', { name: 'Settings' });
  button.focus(); fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  const navigation = within(dialog).getByRole('navigation', { name: 'Settings categories' });
  expect(within(navigation).getByRole('button', { name: 'AI' })).toHaveAttribute('aria-current', 'page');
  await screen.findByLabelText('Connection name');
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Local AI' } });
  fireEvent.click(within(navigation).getByRole('button', { name: 'Cloud' }));
  expect(screen.getByRole('region', { name: 'Cloud settings' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Cloud URL'), { target: { value: 'http://localhost:8787' } });
  fireEvent.click(within(navigation).getByRole('button', { name: 'AI' }));
  expect(screen.getByLabelText('Connection name')).toHaveValue('Local AI');
  fireEvent.click(within(navigation).getByRole('button', { name: 'Cloud' }));
  expect(screen.getByLabelText('Cloud URL')).toHaveValue('http://localhost:8787');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});

test('a Cloud setup action opens the Cloud category directly, outside Assets configuration', async () => {
  setup();
  render(<CloudProvider><SettingsProvider><SettingsButton/><CloudBrowser view="all" project={null} onDraft={async () => {}} onInserted={async () => {}}/></SettingsProvider></CloudProvider>);
  expect(screen.queryByLabelText('Cloud URL')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Cloud connection' }));
  expect(screen.getByRole('region', { name: 'Cloud settings' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'AI settings' })).not.toBeInTheDocument();
  expect(await screen.findByLabelText('Cloud URL')).toBeVisible();
});
