import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GraphNode } from '../api/contracts';

/** Shared by the live editor and offline asset previews. */
export function NoteContent({ node }: { readonly node: GraphNode }) {
  const content = node.stateValues.content ?? node.spec.stateFields?.find((field) => field.name === 'content')?.valueSchema.default;
  return <div className="studio-node-note-content nodrag nowheel" aria-label={`${node.name} document`}>
    <Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}>{typeof content === 'string' ? content : ''}</Markdown>
  </div>;
}
