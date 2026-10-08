import type { DataPortSpec, GraphNode, GraphOperation, GraphPort, ValueSchema } from '../api/contracts';

export type CopiedPortType =
  | { readonly kind: 'state'; readonly schema: ValueSchema }
  | { readonly kind: 'data'; readonly payload: DataPortSpec['payload'] };

export function copyPortType(port: GraphPort): CopiedPortType | null {
  if (port.kind === 'state' && port.stateSpec) return { kind: 'state', schema: port.stateSpec.valueSchema };
  if (port.kind === 'data' && port.dataSpec) return { kind: 'data', payload: port.dataSpec.payload };
  return null;
}

export function canPastePortType(node: GraphNode, port: GraphPort, copied: CopiedPortType | null): boolean {
  if (!copied || copied.kind !== port.kind) return false;
  if (port.kind === 'state') return node.spec.editPolicy?.stateFields?.canEditExisting === true;
  if (port.kind === 'data') return (port.direction === 'input' ? node.spec.editPolicy?.dataInPorts : node.spec.editPolicy?.dataOutPorts)?.canEditExisting === true;
  return false;
}

export function pastePortTypeOperation(node: GraphNode, port: GraphPort, copied: CopiedPortType): GraphOperation {
  if (!canPastePortType(node, port, copied)) throw new Error('This port type is protected or incompatible with the copied type.');
  const spec = copied.kind === 'state'
    ? { ...node.spec, stateFields: node.spec.stateFields?.map((field) => field.name === port.runtimeName ? { ...field, valueSchema: copied.schema } : field) }
    : port.direction === 'input'
      ? { ...node.spec, dataInPorts: node.spec.dataInPorts?.map((field) => field.name === port.runtimeName ? { ...field, payload: copied.payload } : field) }
      : { ...node.spec, dataOutPorts: node.spec.dataOutPorts?.map((field) => field.name === port.runtimeName ? { ...field, payload: copied.payload } : field) };
  if (node.kind === 'operator' && spec.specKind === 'operator') return { op: 'setOperatorSpec', nodeId: node.nodeId, spec };
  if (node.kind === 'service' && spec.specKind === 'service') return { op: 'setServiceSpec', nodeId: node.nodeId, spec };
  throw new Error('Node specification kind does not match its node.');
}
