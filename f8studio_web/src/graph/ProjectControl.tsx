import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { ProjectSummary } from '../api/contracts';

/** The parent keys this control by selected project so switching cancels a draft. */
export function ProjectControl({ projects, selectedProjectId, disabled, onSelect, onAdd, onRemove, onRename }: {
  readonly projects: readonly ProjectSummary[];
  readonly selectedProjectId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (projectId: string) => Promise<void>;
  readonly onAdd: () => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onRename: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const selected = projects.find((item) => item.projectId === selectedProjectId);
  return <div className="project-control">
    <label htmlFor={draft === null ? 'project-select' : 'project-name'}>Project</label>
    {draft === null ? <div>
      <select id="project-select" value={selectedProjectId ?? ''} title={selected?.name} disabled={disabled}
        onChange={(event) => void onSelect(event.target.value)}>
        <option value="" disabled>Select project</option>
        {projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.name}</option>)}
      </select>
      <button type="button" className="small-icon-button" title="Rename project" aria-label="Rename project"
        disabled={disabled || selected === undefined} onClick={() => setDraft(selected?.name ?? '')}><Pencil size={15} /></button>
      <button type="button" className="small-icon-button" title="New project" aria-label="New project" disabled={disabled} onClick={() => void onAdd()}><Plus size={16} /></button>
      <button type="button" className="small-icon-button" title="Delete project" aria-label="Delete project" disabled={disabled || selectedProjectId === null} onClick={() => void onRemove()}><Trash2 size={15} /></button>
    </div> : <form className="project-rename" onSubmit={(event) => {
      event.preventDefault();
      if (!disabled && draft.trim()) void onRename(draft).then((saved) => { if (saved) setDraft(null); });
    }}>
      <input id="project-name" aria-label="Project name" autoFocus required value={draft} disabled={disabled}
        onFocus={(event) => event.target.select()} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && !disabled) { event.preventDefault(); setDraft(null); } }} />
      <button type="submit" className="small-icon-button" title="Save project name" aria-label="Save project name" disabled={disabled || !draft.trim()}><Check size={16} /></button>
      <button type="button" className="small-icon-button" title="Cancel project rename" aria-label="Cancel project rename" disabled={disabled} onClick={() => setDraft(null)}><X size={16} /></button>
    </form>}
  </div>;
}
