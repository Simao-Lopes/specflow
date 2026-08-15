import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import api from './api.js';
import SpecBoard from './components/SpecBoard.jsx';
import NewSpec from './components/NewSpec.jsx';
import SpecDetail from './components/SpecDetail.jsx';
import Config from './components/Config.jsx';
import Pipelines from './components/Pipelines.jsx';

const NAV = [
  { key: 'board', label: 'Spec Board' },
  { key: 'new', label: 'New Spec' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'config', label: 'Config' },
];

export default function App() {
  const [view, setView] = useState('board');
  const [selectedSpecId, setSelectedSpecId] = useState(null);
  const [specs, setSpecs] = useState([]);
  const [config, setConfig] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [stepEvents, setStepEvents] = useState([]);
  const [msgEvents, setMsgEvents] = useState([]);
  const [specEvents, setSpecEvents] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [pipelineEvents, setPipelineEvents] = useState([]);
  const [pipeEditor, setPipeEditor] = useState(null); // { mode:'new' } | { mode:'edit', pipeline }
  const [notifications, setNotifications] = useState([]);
  const [toasts, setToasts] = useState([]);
  const socketRef = useRef(null);
  // Pending "create a new pipeline, then come back" flow, set by NewSpec/SpecDetail.
  const pendingNewRef = useRef(null);
  // NewSpec form draft persisted across the "＋ New pipeline" detour.
  const newSpecDraftRef = useRef(null);

  const refreshSpecs = async () => { try { setSpecs(await api.listSpecs()); } catch (e) { notify(e.message, 'error'); } };
  const refreshConfig = async () => { try { setConfig(await api.getConfig()); } catch (e) { notify(e.message, 'error'); } };
  const refreshPipelines = async () => { try { setPipelines(await api.listPipelines()); } catch (e) { notify(e.message, 'error'); } };
  const refreshJobs = async (specId) => {
    try {
      const list = await api.listJobs(specId);
      setJobs(specId ? list : (prev) => prev);
      return list;
    } catch (e) { notify(e.message, 'error'); return []; }
  };

  const notify = (message, level = 'info') => {
    const id = Date.now() + Math.random();
    setNotifications((n) => [{ id, message, level, ts: Date.now() }, ...n].slice(0, 40));
    setToasts((t) => [...t, { id, message, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  useEffect(() => {
    refreshSpecs();
    refreshConfig();
    refreshPipelines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Socket.IO — same-origin io() works in dev (proxied) and prod (served by backend).
  useEffect(() => {
    const socket = io({ path: '/specflow/socket.io' });
    socketRef.current = socket;

    // watch-all: receive logs for every job, filter client-side
    socket.emit('watch-all');

    socket.on('spec', (p) => {
      setSpecEvents((prev) => { const next = [p, ...prev]; return next.length > 200 ? next.slice(0, 200) : next; });
      if (p && p.deleted) {
        setSpecs((s) => s.filter((x) => String(x.id) !== String(p.id)));
      } else if (p && p.id) {
        setSpecs((s) => {
          const i = s.findIndex((x) => String(x.id) === String(p.id));
          if (i === -1) return [p, ...s];
          const next = [...s];
          next[i] = { ...p };
          return next;
        });
      } else {
        refreshSpecs();
      }
    });

    socket.on('pipeline', (p) => {
      setPipelineEvents((prev) => { const next = [p, ...prev]; return next.length > 200 ? next.slice(0, 200) : next; });
      if (p && p.deleted) {
        setPipelines((s) => s.filter((x) => String(x.id) !== String(p.id)));
      } else if (p && p.id) {
        setPipelines((s) => {
          const i = s.findIndex((x) => String(x.id) === String(p.id));
          if (i === -1) return [p, ...s];
          const next = [...s];
          next[i] = { ...p };
          return next;
        });
      } else {
        refreshPipelines();
      }
    });

    socket.on('job', (j) => {
      if (j && j.id) {
        setJobs((prev) => {
          const i = prev.findIndex((x) => String(x.id) === String(j.id));
          if (i === -1) return [j, ...prev];
          const next = [...prev];
          next[i] = { ...j };
          return next;
        });
      }
    });

    socket.on('log', (entry) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (String(j.id) !== String(entry?.jobId)) return j;
          return { ...j, _liveLogs: [...(j._liveLogs || []), entry] };
        })
      );
    });

    socket.on('step', (s) => {
      if (!s) return;
      setStepEvents((prev) => { const next = [s, ...prev]; return next.length > 200 ? next.slice(0, 200) : next; });
    });

    socket.on('message', (m) => {
      if (!m) return;
      setMsgEvents((prev) => { if (prev.some((x) => x.id !== undefined && String(x.id) === String(m.id))) return prev; const next = [m, ...prev]; return next.length > 200 ? next.slice(0, 200) : next; });
    });

    socket.on('notify', (n) => notify(n?.message || 'Notification', n?.level || 'info'));

    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSpec = (id) => { setSelectedSpecId(id); setView('detail'); };
  const goBoard = () => { setView('board'); setSelectedSpecId(null); };

  // Open the Pipelines section in edit mode for a brand-new pipeline, and
  // (optionally) return to `backTo` view with the created pipeline id via `cb`.
  const openPipelinesForNew = (cb, backTo) => {
    pendingNewRef.current = { cb, backTo: backTo || view };
    setPipeEditor({ mode: 'new' });
    setView('pipelines');
  };

  // Called by Pipelines editor after a NEW pipeline is created.
  const handlePipelineCreated = (p) => {
    refreshPipelines();
    const pend = pendingNewRef.current;
    pendingNewRef.current = null;
    setPipeEditor(null);
    if (pend) {
      if (pend.cb) pend.cb(p.id);
      setView(pend.backTo || 'board');
    }
    // else stay on the Pipelines list (editor closes, list shows).
  };

  const cancelNewPipeline = () => {
    const pend = pendingNewRef.current;
    pendingNewRef.current = null;
    setPipeEditor(null);
    if (pend) setView(pend.backTo || 'board');
  };

  // From NewSpec: create a pipeline, then return to the spec form with it selected.
  const openNewSpecPipeline = () => {
    openPipelinesForNew((newId) => {
      newSpecDraftRef.current = { ...(newSpecDraftRef.current || {}), pipeline_id: newId };
    }, 'new');
  };

  // From SpecDetail: create a pipeline, then attach it to this spec.
  const openDetailPipeline = () => {
    const specId = selectedSpecId;
    openPipelinesForNew((newId) => {
      api.updateSpec(specId, { pipeline_id: newId })
        .then(() => notify('New pipeline attached to spec', 'success'))
        .catch((e) => notify(e.message, 'error'));
    }, 'detail');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={goBoard} role="button" tabIndex={0}>
          <span className="brand-dot" />
          <h1>SpecFlow</h1>
          <span className="brand-sub">spec-driven orchestration</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-btn ${view === n.key ? 'active' : ''}`}
              onClick={() => (n.key === 'board' ? goBoard() : setView(n.key))}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="live-badge" title="Live socket connected"><span className="pulse" /> live</div>
      </header>

      <main className="content">
        {view === 'board' && (
          <SpecBoard specs={specs} onOpen={openSpec} onNotify={notify} onGoNew={() => setView('new')} />
        )}
        {view === 'new' && (
          <NewSpec
            onNotify={notify}
            onSaved={() => { refreshSpecs(); setView('board'); }}
            pipelines={pipelines}
            initialDraft={newSpecDraftRef.current || undefined}
            onDraftChange={(d) => { newSpecDraftRef.current = d; }}
            onOpenPipelinesForNew={openNewSpecPipeline}
            globalRepo={config?.default_repo}
          />
        )}
        {view === 'detail' && selectedSpecId && (
          <SpecDetail
            specId={selectedSpecId}
            onNotify={notify}
            onBack={goBoard}
            jobEvent={jobs.filter((j) => String(j.spec_id) === String(selectedSpecId))}
            onRefreshJob={() => refreshJobs(selectedSpecId)}
            stepEvent={stepEvents}
            messageEvent={msgEvents}
            specEvent={specEvents.filter((e) => e && (e.deleted || String(e.id) === String(selectedSpecId)))}
            pipelines={pipelines}
            onOpenPipelinesForNew={openDetailPipeline}
            globalRepo={config?.default_repo}
          />
        )}
        {view === 'detail' && !selectedSpecId && goBoard()}
        {view === 'pipelines' && (
          <Pipelines
            pipelines={pipelines}
            pipelineEvent={pipelineEvents}
            onNotify={notify}
            editor={pipeEditor}
            onEditorChange={setPipeEditor}
            onCreated={handlePipelineCreated}
            onCancelNew={cancelNewPipeline}
            onChanged={refreshPipelines}
            models={config?.models || {}}
          />
        )}
        {view === 'config' && <Config config={config} onNotify={notify} onChanged={refreshConfig} />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}