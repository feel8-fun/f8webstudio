import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { OperatorNode, StateSpec } from '../api/contracts';
import { StateFieldControl } from './StateFieldControl';

afterEach(cleanup);

const enabledField: StateSpec = {
  name: 'enabled', label: 'Enabled', access: 'rw', control: { kind: 'toggle' }, showOnNode: true,
  valueSchema: { type: 'boolean', default: false },
};
const node: OperatorNode = {
  kind: 'operator', nodeId: 'operator', name: 'Operator', serviceId: 'service', serviceClass: 'f8.pyengine',
  operatorClass: 'test.operator',
  spec: {
    serviceClass: 'f8.pyengine', operatorClass: 'test.operator', label: 'Operator', specKind: 'operator',
    stateFields: [enabledField],
  },
  ports: [], portIds: {}, stateValues: {}, enabled: true,
};

test('commits typed boolean values from a schema-driven control', () => {
  const commit = vi.fn();
  render(<StateFieldControl node={node} field={enabledField} disabled={false} onCommit={commit} />);

  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));

  expect(commit).toHaveBeenCalledWith(true);
});

test('renders upstream-driven state as read-only', () => {
  render(<StateFieldControl node={node} field={enabledField} disabled={false} connected onCommit={vi.fn()} />);

  expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeDisabled();
  expect(screen.getByText('Upstream')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('renders live retained values for readonly state without a null placeholder', () => {
  const readonlyField: StateSpec = {
    name: 'videoWidth', label: 'Video Width', access: 'ro', valueSchema: { type: 'integer' },
  };
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [readonlyField] } }}
    field={readonlyField}
    disabled={false}
    runtimeValue={{ field: 'videoWidth', found: true, value: 1920, tsMs: 123 }}
    onCommit={vi.fn()}
  />);

  expect(screen.getByText('1920')).toBeInTheDocument();
  expect(screen.queryByText('null')).not.toBeInTheDocument();
});

test('shows saved writable configuration despite retained runtime values and preserves an active text edit', () => {
  const urlField: StateSpec = {
    name: 'mediaUrl', label: 'Media URL', access: 'rw', valueSchema: { type: 'string', default: '' },
  };
  const props = {
    node: { ...node, spec: { ...node.spec, stateFields: [urlField] }, portIds: {}, stateValues: { mediaUrl: 'draft.mp4' } },
    field: urlField, disabled: false, onCommit: vi.fn(),
  };
  const view = render(<StateFieldControl {...props} runtimeValue={{ field: 'mediaUrl', found: true, value: 'player.mp4', tsMs: 1 }} />);
  const input = screen.getByRole('textbox', { name: 'Media URL' });
  expect(input).toHaveValue('draft.mp4');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'typing.mp4' } });
  view.rerender(<StateFieldControl {...props} runtimeValue={{ field: 'mediaUrl', found: true, value: 'other.mp4', tsMs: 2 }} />);
  expect(input).toHaveValue('typing.mp4');
  fireEvent.blur(input);
  expect(props.onCommit).toHaveBeenCalledWith('typing.mp4');
});

test('a stale runtime value cannot hide a saved edit or prevent saving a value matching the cache', () => {
  const field: StateSpec = { name: 'tickMs', label: 'Tick (ms)', access: 'rw', persistent: true,
    publishable: true, valueSchema: { type: 'integer', default: 100 } };
  const commit = vi.fn();
  const props = { field, disabled: false, onCommit: commit,
    runtimeValue: { field: 'tickMs', found: true, value: 100, tsMs: 1 } };
  const view = render(<StateFieldControl {...props} node={{ ...node, stateValues: { tickMs: 250 } }} />);
  const input = screen.getByRole('spinbutton', { name: 'Tick (ms)' });
  expect(input).toHaveValue(250);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '100' } });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledWith(100);
  view.rerender(<StateFieldControl {...props} node={{ ...node, stateValues: { tickMs: 100 } }} />);
  expect(input).toHaveValue(100);
});

test('runtime-only writable state and upstream-driven state still display live values', () => {
  const field: StateSpec = { name: 'value', label: 'Value', access: 'rw', persistent: false,
    valueSchema: { type: 'integer', default: 0 } };
  const props = { node: { ...node, stateValues: { value: 1 } }, field, disabled: false, onCommit: vi.fn() };
  const view = render(<StateFieldControl {...props} runtimeValue={{ field: 'value', found: true, value: 5, tsMs: 1 }} />);
  expect(screen.getByRole('spinbutton', { name: 'Value' })).toHaveValue(5);
  view.rerender(<StateFieldControl {...props} field={{ ...field, persistent: true }} connected
    runtimeValue={{ field: 'value', found: true, value: 8, tsMs: 2 }} />);
  expect(screen.getByRole('spinbutton', { name: 'Value' })).toHaveValue(8);
  expect(screen.getByRole('spinbutton', { name: 'Value' })).toHaveAttribute('readonly');
});

test('labels missing readonly runtime state as unavailable', () => {
  const readonlyField: StateSpec = {
    name: 'captureRunning', label: 'Capture Running', access: 'ro', valueSchema: { type: 'boolean' },
  };
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [readonlyField] } }}
    field={readonlyField}
    disabled={false}
    runtimeValue={{ field: 'captureRunning', found: false, value: null, tsMs: null }}
    onCommit={vi.fn()}
  />);

  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.queryByText('null')).not.toBeInTheDocument();
});

test('keeps the compact numeric input mounted when upstream drives its value', () => {
  const numberField: StateSpec = {
    name: 'level', label: 'Level', access: 'rw', valueSchema: { type: 'number', default: 0.5 },
  };
  const commit = vi.fn();
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [numberField] } }}
    field={numberField}
    compact
    connected
    disabled={false}
    onCommit={commit}
  />);

  const input = screen.getByRole('spinbutton');
  expect(input).toHaveAttribute('readonly');
  fireEvent.change(input, { target: { value: '0.75' } });
  fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled();
});

test('does not commit an unchanged default value when an editor loses focus', () => {
  const numberField: StateSpec = {
    name: 'interval', label: 'Interval', access: 'rw', valueSchema: { type: 'number', default: 8 },
  };
  const commit = vi.fn();
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [numberField] } }}
    field={numberField}
    disabled={false}
    onCommit={commit}
  />);

  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Interval' }));

  expect(commit).not.toHaveBeenCalled();
});

test('commits typed arrays from a dynamic multiselect control', () => {
  const poolField: StateSpec = {
    name: 'available', access: 'ro', valueSchema: { type: 'array', items: { type: 'string' }, default: ['left', 'right'] },
  };
  const selectedField: StateSpec = {
    name: 'selected', label: 'Selected', access: 'rw', control: { kind: 'multiselect', optionsFromState: 'available' },
    valueSchema: { type: 'array', items: { type: 'string' }, default: ['left'] },
  };
  const commit = vi.fn();
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [poolField, selectedField] } }}
    field={selectedField}
    disabled={false}
    onCommit={commit}
  />);
  const listbox = screen.getByRole('listbox', { name: 'Selected' });
  for (const option of listbox.querySelectorAll('option')) option.selected = true;

  fireEvent.change(listbox);

  expect(commit).toHaveBeenCalledWith(['left', 'right']);
});

test('selects from a live readonly device list and preserves an unavailable selection', () => {
  const devices: StateSpec = {
    name: 'availableDevices', access: 'ro', valueSchema: { type: 'array', items: { type: 'string' } },
  };
  const selected: StateSpec = {
    name: 'selectedDevice', label: 'Capture device', access: 'wo',
    control: { kind: 'select', optionsFromState: 'availableDevices' },
    valueSchema: { type: 'string', default: 'Auto' },
  };
  const commit = vi.fn();
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [devices, selected] } }}
    field={selected}
    disabled={false}
    runtimeValue={{ field: 'selectedDevice', found: true, value: 'Recording: Built-in Mic', tsMs: 1 }}
    runtimeValues={{ availableDevices: {
      field: 'availableDevices', found: true, value: ['Recording: USB Mic', 'Recording: Built-in Mic'], tsMs: 1,
    } }}
    onCommit={commit}
  />);

  const select = screen.getByRole('combobox', { name: 'Capture device' });
  expect(select).toHaveValue('"Auto"');
  expect(screen.getByRole('option', { name: 'Auto (unavailable)' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: '"Recording: USB Mic"' } });
  expect(commit).toHaveBeenCalledWith('Recording: USB Mic');
});

test('uses a fixed single-line editor for compact wrapline state', () => {
  const expressionField: StateSpec = {
    name: 'code', label: 'Expr', access: 'rw', control: { kind: 'textarea', language: 'python' },
    valueSchema: { type: 'string', default: 'value * 2' },
  };
  render(<StateFieldControl
    node={{ ...node, spec: { ...node.spec, stateFields: [expressionField] } }}
    field={expressionField}
    compact
    disabled={false}
    onCommit={vi.fn()}
  />);

  expect(screen.getByRole('textbox').tagName).toBe('INPUT');
  expect(document.querySelector('textarea')).toBeNull();
});

test('runtime-only buttons keep distinct trigger values while live updates arrive', () => {
  const field: StateSpec = { name: 'trigger', access: 'rw', persistent: false, publishable: false,
    control: { kind: 'button' }, valueSchema: { type: 'integer', default: 0 } };
  const commit = vi.fn();
  render(<StateFieldControl node={node} field={field} disabled={false} onCommit={commit} />);
  const trigger = screen.getByRole('button', { name: 'Trigger trigger' });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(commit.mock.calls).toEqual([[1], [2]]);
  expect(node.stateValues).toEqual({});
});
