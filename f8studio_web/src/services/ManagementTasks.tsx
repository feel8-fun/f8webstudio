import { useEffect, useRef, useState } from 'react';

import { cancelManagementJob, fetchManagementJobLogs, fetchManagementJobs } from '../api/client';
import { isActiveJob, useHistoryVisibility } from './useHistoryVisibility';
import type { ManagementJob } from '../api/contracts.gen';

export function useManagementJobs(onChange: (completed: boolean) => Promise<void>) {
  const [jobs, setJobs] = useState<readonly ManagementJob[]>([]);
  const [error, setError] = useState('');
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let previous = '';
    let previousJobs: readonly ManagementJob[] = [];
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await fetchManagementJobs(controller.signal);
        if (controller.signal.aborted) return;
        setJobs(next); setError('');
        const signature = JSON.stringify(next.map((job) => [job.jobId, job.state]));
        const completed = next.some((job) => !['queued', 'running'].includes(job.state) &&
          !previousJobs.some((old) => old.jobId === job.jobId && !['queued', 'running'].includes(old.state)));
        if (previous && signature !== previous) await callback.current(completed);
        previous = signature;
        previousJobs = next;
      } catch (reason: unknown) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to check maintenance tasks');
      } finally { pending = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return { jobs, error };
}

export function ManagementTasks({ jobs, error }: { jobs: readonly ManagementJob[]; error: string }) {
  const history = useHistoryVisibility('f8-maintenance-dismissed');
  const visible = jobs.filter((job) => isActiveJob(job.state) || !history.dismissed.includes(job.jobId));
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [log, setLog] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running').sort((a, b) => a.createdAt - b.createdAt);
  const recent = visible.filter((job) => !isActiveJob(job.state));
  const selectedJob = jobs.find((job) => job.jobId === selected);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void fetchManagementJobLogs(selected, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLog(result.log);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setFailure(reason instanceof Error ? reason.message : 'Unable to read task logs');
    });
    return () => controller.abort();
  }, [selected, selectedJob?.state, selectedJob?.detail]);
  if (!visible.length && !error && !failure) return null;
  return <div className="maintenance-task-menu">
    <button className="command-button" type="button" aria-expanded={open} aria-controls="maintenance-task-popover" onClick={() => { setOpen(!open); setSelected(''); }}>Tasks · {active.length} active{error || failure ? ' · error' : ''}</button>
    {open && <section id="maintenance-task-popover" className="management-tasks" aria-label="Maintenance tasks">
    <div className="history-toolbar"><strong>Maintenance tasks · {visible.length}</strong><button className="command-button" disabled={!recent.length} onClick={() => { history.dismiss(recent.map((job) => job.jobId)); setSelected(''); }}>Delete completed</button><button className="command-button" onClick={() => { setOpen(false); setSelected(''); }}>Close tasks</button></div>
    {(error || failure) && <p role="alert">{error || failure}</p>}
    <div className="history-records">
    {[...active, ...recent].map((job) => <article key={job.jobId} className="extension-row">
      <div className="extension-heading"><strong>{job.request.action.replaceAll('-', ' ')} · {job.request.extensionId || job.request.environmentId || 'packages'}</strong><span className="extension-state">{job.state}</span></div>
      <time dateTime={new Date(job.createdAt * 1000).toISOString()}>{new Date(job.createdAt * 1000).toLocaleString()}</time>
      {job.startedAt != null && <small> · {Math.max(0, (job.finishedAt ?? Date.now() / 1000) - job.startedAt).toFixed(1)}s</small>}
      <button className="command-button" onClick={() => { setSelected(job.jobId); setLog(''); setFailure(''); }}>Task logs</button>
      {['queued', 'running'].includes(job.state) && job.cancellable && !job.cancelRequested && <button className="command-button" disabled={busy === job.jobId} onClick={() => void (async () => {
        setBusy(job.jobId); setFailure('');
        try { await cancelManagementJob(job.jobId); }
        catch (reason: unknown) { setFailure(reason instanceof Error ? reason.message : 'Unable to cancel task'); }
        finally { setBusy(''); }
      })()}>Cancel task</button>}
      {!isActiveJob(job.state) && <button className="command-button" onClick={() => { history.dismiss([job.jobId]); if (selected === job.jobId) setSelected(''); }}>Delete record</button>}
    </article>)}</div>
    {selected && <div><button className="command-button" onClick={() => setSelected('')}>Close logs</button><pre aria-label="Task logs">{log || selectedJob?.detail || 'Loading…'}</pre></div>}
  </section>}</div>;
}
