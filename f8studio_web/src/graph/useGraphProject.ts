import type { ExcludedState } from "../api/contracts.gen";
import { useCallback, useEffect, useRef, useState } from 'react';

import { changeHistory, createProject, deleteProject, exportProjectGraph, exportSharedProjectGraph, fetchCatalog, fetchLatestDeployment, fetchProject, fetchProjects, importProjectGraph, patchProject, refreshCatalog, updateProject } from '../api/client';
import { isProjectRecord, isStudioDocument } from '../api/contracts';
import { studioEvents } from '../api/eventStream';

import type { CatalogSnapshot, DeployJob, GraphOperation, ProjectRecord, ProjectSummary } from '../api/contracts';

import { MutationQueue } from './MutationQueue';

import { errorMessage, documentIsNewer } from './workspaceUtils';
const SELECTED_PROJECT_KEY = 'f8studio.selectedProjectId';

export function useGraphProject(resetSelection: () => void, reportCommand: (kind: 'success' | 'error', title: string, detail: string) => void) {
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<DeployJob | null>(null);
  const [mutations] = useState(() => new MutationQueue());
  const projectRef = useRef<ProjectRecord | null>(null);
  const selectionGeneration = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const projectId = project?.projectId ?? null;
  projectRef.current = project;

  const applyProjectMetadata = useCallback((record: ProjectRecord) => {
    const metadata = { name: record.name, description: record.description, updatedAt: record.updatedAt };
    setProjects((current) => current.map((item) => item.projectId === record.projectId ? { ...item, ...metadata } : item));
    // Metadata responses must not replace a newer graph received during the request.
    setProject((current) => current?.projectId === record.projectId ? { ...current, ...metadata } : current);
  }, []);

  const beginSelection = useCallback((id: string | null) => {
    const generation = ++selectionGeneration.current;
    selectedIdRef.current = id;
    projectRef.current = null;
    setSelectedProjectId(id);
    setProject(null);
    setDeployment(null);
    return generation;
  }, []);

  const reloadProject = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const generation = selectionGeneration.current;
    const [loaded, latestDeployment] = await Promise.all([
      fetchProject(projectId, signal),
      fetchLatestDeployment(projectId, signal),
    ]);
    if (!signal?.aborted && generation === selectionGeneration.current && selectedIdRef.current === projectId) {
      projectRef.current = loaded;
      setProject(loaded);
      setDeployment(latestDeployment);
    }
    return loaded;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = selectionGeneration.current;
    const load = async () => {
      try {
        const [availableProjects, loadedCatalog] = await Promise.all([
          fetchProjects(controller.signal),
          fetchCatalog(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setCatalog(loadedCatalog);
        if (generation !== selectionGeneration.current) return;
        setProjects(availableProjects);
        const rememberedId = localStorage.getItem(SELECTED_PROJECT_KEY);
        const initial = availableProjects.find((item) => item.projectId === rememberedId) ?? availableProjects.at(-1);
        if (initial !== undefined) {
          selectedIdRef.current = initial.projectId;
          setSelectedProjectId(initial.projectId);
          await reloadProject(initial.projectId, controller.signal);
        }
      } catch (reason) {
        if (!controller.signal.aborted && generation === selectionGeneration.current) setError(errorMessage(reason));
      }
    };
    void load();
    return () => { controller.abort(); ++selectionGeneration.current; };
  }, [reloadProject]);

  useEffect(() => {
    if (selectedProjectId !== null) localStorage.setItem(SELECTED_PROJECT_KEY, selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (projectId === null) return;
    let disposed = false;
    const refresh = () => {
        void fetchProject(projectId).then((record) => {
          const current = projectRef.current;
          if (!disposed && selectedIdRef.current === projectId && (current === null || documentIsNewer(record.document, current.document))) {
            setProject(record);
          }
        }, (reason: unknown) => {
          if (!disposed && selectedIdRef.current === projectId) setError((current) => current ?? errorMessage(reason));
        });
    };
    const unsubscribe = studioEvents.subscribe((envelope) => {
        if (disposed || selectedIdRef.current !== projectId) return;
        if (envelope.type === 'project.updated' && envelope.scope === `project:${projectId}` && isProjectRecord(envelope.payload)) {
          applyProjectMetadata(envelope.payload);
          return;
        }
        if (envelope.type === 'project.deleted' && envelope.scope === `project:${projectId}`) {
          setProjects((current) => current.filter((item) => item.projectId !== projectId));
          const generation = beginSelection(null);
          localStorage.removeItem(SELECTED_PROJECT_KEY);
          resetSelection();
          void fetchProjects().then(async (available) => {
            if (generation !== selectionGeneration.current) return;
            setProjects(available);
            const next = available[0];
            if (next !== undefined) {
              beginSelection(next.projectId);
              await reloadProject(next.projectId);
            }
          }).catch((reason: unknown) => setError(errorMessage(reason)));
          return;
        }
        if (envelope.type !== 'graph.committed' || envelope.scope !== `project:${projectId}` ||
          typeof envelope.payload !== 'object' || envelope.payload === null) return;
        const payload = envelope.payload as Record<string, unknown>;
        const document = payload.document;
        if (!isStudioDocument(document)) return;
        setProject((current) => {
          if (current === null || current.projectId !== projectId ||
            !documentIsNewer(document, current.document)) return current;
          return { ...current, document };
        });
    }, refresh);
    return () => { disposed = true; unsubscribe(); };
  }, [projectId, reloadProject, resetSelection, applyProjectMetadata, beginSelection]);

  const mutateProject = useCallback((targetId: string, operation: (current: ProjectRecord) => Promise<ProjectRecord>): Promise<void> => {
    setSaving(true);
    setError(null);
    const result = mutations.enqueue(async () => {
      const current = projectRef.current;
      if (current === null || current.projectId !== targetId) throw new Error('The selected project changed before this edit could be saved.');
      try {
        const updated = await operation(current);
        const latest = projectRef.current;
        if (latest?.projectId === targetId && !documentIsNewer(latest.document, updated.document)) {
          projectRef.current = updated;
          setProject(updated);
        }
      } catch (reason) {
        // Refresh before queued work is released, without switching the selected project.
        const loaded = await fetchProject(targetId);
        if (projectRef.current?.projectId === targetId) {
          projectRef.current = loaded;
          setProject(loaded);
        }
        throw reason;
      }
    });
    // Attach an error observer for fire-and-forget UI callbacks. Return the original
    // promise so editors that await persistence still receive the failure.
    void result.then(() => {
      setSaving(mutations.pending > 0);
    }, (reason: unknown) => {
      setSaving(mutations.pending > 0);
      setError(errorMessage(reason));
    });
    return result;
  }, [mutations]);

  const commit = useCallback((operations: readonly GraphOperation[]): Promise<void> => {
    if (operations.length === 0) return Promise.resolve();
    return mutateProject(project?.projectId ?? '', async (current) => {
      const result = await patchProject(current.projectId, current.document, operations);
      if (result.runtimeErrors.length > 0) setError(`${result.graphChanged ? 'Saved to project, but runtime sync failed' : 'Runtime state update failed'}: ${result.runtimeErrors.join('; ')}`);
      return { ...current, document: result.document };
    });
  }, [mutateProject, project?.projectId]);

  const selectProject = useCallback(async (projectId: string) => {
    setBusy(true);
    setError(null);
    const generation = beginSelection(projectId);
    resetSelection();
    try {
      await reloadProject(projectId);
    } catch (reason) {
      if (generation === selectionGeneration.current) setError(errorMessage(reason));
    } finally {
      if (generation === selectionGeneration.current) setBusy(false);
    }
  }, [reloadProject, resetSelection, beginSelection]);

  const addProject = useCallback(async () => {
    setBusy(true);
    setError(null);
    const generation = ++selectionGeneration.current;
    try {
      const created = await createProject(`Untitled ${projects.length + 1}`);
      const available = await fetchProjects();
      if (generation !== selectionGeneration.current) return;
      setProjects(available);
      selectedIdRef.current = created.projectId;
      setSelectedProjectId(created.projectId);
      projectRef.current = created;
      setProject(created);
      setDeployment(null);
      resetSelection();
    } catch (reason) {
      if (generation === selectionGeneration.current) setError(errorMessage(reason));
    } finally {
      if (generation === selectionGeneration.current) setBusy(false);
    }
  }, [projects.length, resetSelection]);

  const removeProject = useCallback(async () => {
    const selected = projects.find((item) => item.projectId === selectedProjectId);
    if (selected === undefined || busy || saving || mutations.pending > 0) return;
    if (!window.confirm(`Delete project "${selected.name}" and its saved versions, deployments, and agent sessions? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProject(selected.projectId);
      setProjects((current) => current.filter((item) => item.projectId !== selected.projectId));
      beginSelection(null);
      localStorage.removeItem(SELECTED_PROJECT_KEY);
      const available = await fetchProjects();
      setProjects(available);
      const next = available[0];
      if (next !== undefined) {
        await selectProject(next.projectId);
      }
      resetSelection();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, projects, saving, selectProject, selectedProjectId, resetSelection, mutations, beginSelection]);

  const renameProject = useCallback(async (name: string): Promise<boolean> => {
    const current = projectRef.current;
    if (current === null || busy || saving || mutations.pending > 0) return false;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Project name must be non-empty.');
      return false;
    }
    if (trimmed === current.name) return true;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProject(current.projectId, { name: trimmed, description: current.description });
      applyProjectMetadata(updated);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, saving, mutations, applyProjectMetadata]);

  const history = useCallback(async (action: 'undo' | 'redo') => {
    if (project === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await mutateProject(project.projectId, async (current) => {
        const result = await changeHistory(current.projectId, action, current.document);
        return { ...current, document: result.document };
      });
    } catch (reason) {
      setError(errorMessage(reason));
      await reloadProject(project.projectId);
    } finally {
      setBusy(false);
    }
  }, [busy, mutateProject, project, reloadProject]);

  const downloadGraph = useCallback(async (excludedStates?: readonly ExcludedState[]) => {
    if (project === null || busy) return;
    setError(null);
    try {
      const content = excludedStates === undefined ? await exportProjectGraph(project.projectId) :
        await exportSharedProjectGraph(project.projectId, project.document, excludedStates);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${project.projectId}${excludedStates === undefined ? '' : '.shared'}.f8graph.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    }
  }, [busy, project]);

  const uploadGraph = useCallback(async (file: File) => {
    if (project === null || busy) return;
    if (!window.confirm(`Replace the graph in ${project.name} with ${file.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const content = await file.text();
      await mutateProject(project.projectId, (current) => importProjectGraph(current.projectId, content, current.document));
      resetSelection();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, mutateProject, project, resetSelection]);

  const refreshNodeCatalog = useCallback(async () => {
    if (busy || refreshingCatalog) return;
    setRefreshingCatalog(true);
    setError(null);
    try {
      const updated = await refreshCatalog();
      setCatalog(updated);
      reportCommand('success', 'Node catalog refreshed', `${updated.operators.length} operators available`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRefreshingCatalog(false);
    }
  }, [busy, refreshingCatalog, reportCommand]);

  return { projects, selectedProjectId, project, catalog, busy, setBusy, saving, error, setError,
    deployment, setDeployment, setCatalog, refreshingCatalog, reloadProject, commit,
    selectProject, addProject, removeProject, renameProject, history, downloadGraph, uploadGraph, refreshNodeCatalog };
}
