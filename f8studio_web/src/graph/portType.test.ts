import { expect, test } from 'vitest';
import type { GraphPort, OperatorNode } from '../api/contracts';
import { canPastePortType, copyPortType, pastePortTypeOperation } from './portType';

const field = { name: 'port', access: 'rw' as const, valueSchema: { type: 'any' as const } };
const port: GraphPort = { portId: 'state:input:port', name: 'port', runtimeName: 'port', kind: 'state', direction: 'input', stateSpec: field, dataSpec: null };
const node: OperatorNode = { kind: 'operator', nodeId: 'hub', name: 'Hub', operatorClass: 'f8.patch_hub', serviceClass: 'f8.pystudio', serviceId: 'studio', enabled: true, stateValues: {}, portIds: {}, ports: [port],
  spec: { specKind: 'operator', operatorClass: 'f8.patch_hub', serviceClass: 'f8.pystudio', label: 'Hub', stateFields: [field], editPolicy: { stateFields: { canEditExisting: true } } } };

test('copies the full schema and pastes only the type into an editable state', () => {
  const copied = copyPortType({ ...port, stateSpec: { ...field, valueSchema: { type: 'integer', minimum: 1, maximum: 65535 } } });
  if (!copied) throw new Error('Expected copied state type');
  expect(pastePortTypeOperation(node, port, copied)).toMatchObject({ op: 'setOperatorSpec', nodeId: 'hub', spec: { stateFields: [{ ...field, valueSchema: { type: 'integer', minimum: 1, maximum: 65535 } }] } });
  expect(node.spec.stateFields?.[0]?.valueSchema.type).toBe('any');
});

test('refuses protected definitions and incompatible type categories', () => {
  const copied = copyPortType(port);
  expect(canPastePortType({ ...node, spec: { ...node.spec, editPolicy: {} } }, port, copied)).toBe(false);
  expect(canPastePortType(node, port, { kind: 'data', payload: { kind: 'json', valueSchema: { type: 'number' } } })).toBe(false);
  if (copied) expect(() => pastePortTypeOperation({ ...node, spec: { ...node.spec, editPolicy: {} } }, port, copied)).toThrow('protected');
});

test('copies complete data payload definitions and updates only the selected direction', () => {
  const data = { name: 'packet', payload: { kind: 'json' as const, valueSchema: { type: 'any' as const } } };
  const dataPort: GraphPort = { ...port, kind: 'data', runtimeName: 'packet', name: 'packet', dataSpec: data, stateSpec: null };
  const editable = { ...node, spec: { ...node.spec, dataInPorts: [data], dataOutPorts: [data], editPolicy: { dataInPorts: { canEditExisting: true } } } };
  const copied = copyPortType({ ...dataPort, dataSpec: { ...data, payload: { kind: 'json', valueSchema: { type: 'object', properties: { port: { type: 'integer' } } } } } });
  if (!copied) throw new Error('Expected copied data type');
  const op = pastePortTypeOperation(editable, dataPort, copied);
  expect(op).toMatchObject({ spec: { dataInPorts: [{ payload: { valueSchema: { type: 'object' } } }], dataOutPorts: [data] } });
});
