import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import api from './api.js';
import SpecBoard from './components/SpecBoard.jsx';
import NewSpec from './components/NewSpec.jsx';
import SpecDetail from './components/SpecDetail.jsx';
import Agents from './components/Agents.jsx';
import Config from './components/Config.jsx';

const NAV = [
  { key: 'board', label: 'Spec Board' },
  { key: 'new', label: 'New Spec' },
  { key: 'agents', label: 'Agents' },
  { key: 'config', label: 'Config' },
];

export default function App() {
  const [view, setView] = useState('board');
  const [selectedSpecId, setSelectedSpecId] = useState(null);
  const [specs, setSpecs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [config, setConfig] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [toasts, setToasts] = useState([]);
  const socketRef = useRef(null);

  const refreshSpecs = async () => { try { setSpecs(await api.listSpecs()); } catch (e) { notify(e.message, 'error'); } };
  const refreshAgents = async () => { try { setAgents(await api.listAgents()); } catch (e) { notify(e.message, 'error'); } };
  const refreshConfig = async () => { try { setConfig(await api.getConfig()); } catch (e) { notify(e.message, 'error'); } };
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
    refreshAgents();
    refreshConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Socket.IO — same-origin io() works in dev (proxied) and prod (served by backend).
  useEffect(() => {
    const socket = io({ path: undefined });
    socketRef.current = socket;

    // watch-all: receive logs for every job, filter client-side
    socket.emit('watch-all');

    socket.on('spec', (p) => {
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

    socket.on('notify', (n) => notify(n?.message || 'Notification', n?.level || 'info'));

    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSpec = (id) => {
    setSelectedSpecId(id);
    setView('detail');
  };

  const goBoard = () => { setView('board'); setSelectedSpecId(null); };

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
        {view === 'new' && <NewSpec onNotify={notify} onSaved={() => { refreshSpecs(); setView('board'); }} />}
        {view === 'detail' && selectedSpecId && (
          <SpecDetail
            specId={selectedSpecId}
            config={config}
            onNotify={notify}
            onBack={goBoard}
            jobEvent={jobs.filter((j) => String(j.spec_id) === String(selectedSpecId))}
            onRefreshJob={() => refreshJobs(selectedSpecId)}
          />
        )}
        {view === 'detail' && !selectedSpecId && goBoard()}
        {view === 'agents' && <Agents agents={agents} config={config} onNotify={notify} onChanged={() => { refreshAgents(); }} />}
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