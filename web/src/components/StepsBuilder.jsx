import { useState } from 'react';
import PromptEditor from './PromptEditor.jsx';

const STEP_HARNESSES = ['custom', 'hermes', 'claude', 'llm'];
const STEP_PROVIDERS = ['gemini', 'openrouter', 'nvidia', 'ollama', 'litellm'];

let _seq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Default pipeline: Plan (llm) -> Code (hermes, verified by a custom Test that iterates).
export function defaultSteps() {
  return [
    {
      id: 'plan',
      name: 'Plan',
      method: '',
      harness: 'llm',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      iterations: 1,
      on_failure: 'continue',
      verify: [],
      command: '',
      prompt: '',
    },
    {
      id: 'code',
      name: 'Code',
      method: '',
      harness: 'hermes',
      provider: null,
      model: null,
      iterations: 3,
      on_failure: 'stop',
      verify: [
        {
          id: 'test',
          name: 'Test',
          method: '',
          harness: 'custom',
          command: '',
          iterations: 1,
          on_failure: 'stop',
          verify: [],
          provider: null,
          model: null,
          prompt: '',
        },
      ],
      command: '',
      prompt: '',
    },
  ];
}

const emptyStep = (prefix) => ({
  id: uid(prefix),
  name: '',
  method: '',
  harness: 'llm',
  provider: 'gemini',
  model: '',
  iterations: 1,
  on_failure: 'continue',
  verify: [],
  command: '',
  prompt: '',
});

// Human-readable description of the pipeline flow.
export function flowHint(steps) {
  if (!steps || steps.length === 0) return 'No steps configured yet.';
  const parts = steps.map((s) => {
    let label = s.name || '(unnamed)';
    if ((s.verify || []).length > 0) {
      const v = s.verify.map((x) => x.name || '(unnamed)').join(', ');
      label += ` ⇄ ${v}`;
      if ((s.iterations || 1) > 1) label += ` (iterate ×${s.iterations})`;
    }
    return label;
  });
  return parts.join(' → ');
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Model picker: a dropdown of the provider's known models, plus a free-text
// "custom" option for anything not in the catalog. Falls back to a plain text
// input when the provider has no catalog or isn't an LLM provider.
function ModelSelect({ provider, model, onChange, models }) {
  const catalog = (models && provider && models[provider]) || [];
  const inCatalog = catalog.some((m) => m === model);
  const [customMode, setCustomMode] = useState(() => catalog.length > 0 && !!model && !inCatalog);

  // No catalog for this provider (e.g. custom harness) → plain text input.
  if (catalog.length === 0) {
    return (
      <input className="input mono" value={model || ''} onChange={(e) => onChange(e.target.value || null)} placeholder="model" />
    );
  }

  return (
    <>
      <select
        className="input mono"
        value={customMode ? '__custom__' : (inCatalog ? model : '')}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') { setCustomMode(true); return; } // keep model text, reveal input
          setCustomMode(false);
          onChange(v || null);
        }}
      >
        <option value="">(auto)</option>
        {catalog.map((m) => <option key={m} value={m}>{m}</option>)}
        <option value="__custom__">custom…</option>
      </select>
      {customMode && (
        <input className="input mono model-custom" value={model || ''} onChange={(e) => onChange(e.target.value || null)} placeholder="custom model id" />
      )}
    </>
  );
}

// Resolve a method id against the library to display its kind + label chip.
function findMethod(methods, id) {
  if (!id || !methods) return null;
  const scan = (group) => {
    const g = methods[group] || {};
    for (const phase of Object.keys(g)) {
      const found = (g[phase] || []).find((x) => x && x.id === id);
      if (found) return { ...found, phase, kind: group === 'templates' ? 'template' : 'custom' };
    }
    return null;
  };
  return scan('templates') || scan('custom');
}

// Method picker: default "custom (full control)", industry templates grouped
// by phase (simplest→most complex), and custom actions. Sets only step.method.
function MethodSelect({ value, onChange, methods }) {
  const phases = (methods && methods.phases) || {};
  const templates = (methods && methods.templates) || {};
  const customActions = (methods && methods.custom) || {};

  // Keep backend (object key) order; fall back to a fixed logical order if the
  // shape is unexpected or empty.
  const templateOrder = Object.keys(templates).length ? Object.keys(templates) : ['plan', 'code', 'test'];
  const customOrder = Object.keys(customActions).length ? Object.keys(customActions) : ['plan', 'code', 'test'];
  const phaseLabel = (ph) => (phases && phases[ph]) || ph;

  const hasTemplates = templateOrder.some((ph) => (templates[ph] || []).length);
  const hasCustom = customOrder.some((ph) => (customActions[ph] || []).length);
  const active = findMethod(methods, value);

  return (
    <Field label="Method">
      <select
        className="input method-select"
        value={value || ''}
        onChange={(e) => onChange(e.target.value || '')}
      >
        <option value="">— custom (full control) —</option>
        {hasTemplates && (
          <optgroup label="Templates">
            {templateOrder.map((ph) =>
              (templates[ph] || []).map((tmpl) => (
                <option key={tmpl.id} value={tmpl.id}>{`[${phaseLabel(ph)}] ${tmpl.name}`}</option>
              ))
            )}
          </optgroup>
        )}
        {hasCustom && (
          <optgroup label="Custom actions">
            {customOrder.map((ph) =>
              (customActions[ph] || []).map((a) => (
                <option key={a.id} value={a.id}>{`[${phaseLabel(ph)}] ${a.name || a.id}`}</option>
              ))
            )}
          </optgroup>
        )}
      </select>
      {active && (
        <span className="method-chip mono" title={`method: ${value}`}>
          {active.kind} · {active.phase} · {value}
        </span>
      )}
    </Field>
  );
}

// Editable sub-agents (the verify flow) for a single step.
function VerifierList({ verifiers, onChange, models, methods }) {
  const [open, setOpen] = useState(true);

  const setVerifier = (i, patch) => {
    const next = [...verifiers];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  if (verifiers.length === 0) {
    return (
      <div className="verify-block">
        <div className="verify-head">
          <span className="verify-title">Verify</span>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => onChange([...verifiers, emptyStep('vf')])}
          >
            + Add verifier
          </button>
        </div>
        <p className="muted small">No verifiers. Add a sub-agent to check this step's output.</p>
      </div>
    );
  }

  return (
    <div className="verify-block">
      <div className="verify-head">
        <button type="button" className="btn small ghost" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} Verify ({verifiers.length})
        </button>
        <button type="button" className="btn small ghost" onClick={() => onChange([...verifiers, emptyStep('vf')])}>
          + Add verifier
        </button>
      </div>
      {open &&
        verifiers.map((v, i) => (
          <div className="verify-item" key={v.id}>
            <MethodSelect value={v.method} onChange={(m) => setVerifier(i, { method: m })} methods={methods} />
            <Field label="Name">
              <input className="input" value={v.name} onChange={(e) => setVerifier(i, { name: e.target.value })} placeholder="e.g. Test" />
            </Field>
            <div className="row">
              <Field label="Harness">
                <select className="input" value={v.harness} onChange={(e) => setVerifier(i, { harness: e.target.value })}>
                  {STEP_HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </Field>
              <Field label="On failure">
                <select className="input" value={v.on_failure} onChange={(e) => setVerifier(i, { on_failure: e.target.value })}>
                  <option value="stop">stop</option>
                  <option value="continue">continue</option>
                </select>
              </Field>
              <Field label="Iterations">
                <input type="number" min={1} className="input" value={v.iterations} onChange={(e) => setVerifier(i, { iterations: Number(e.target.value) || 1 })} />
              </Field>
            </div>
            {v.harness === 'custom' ? (
              <Field label="Command">
                <input className="input mono" value={v.command} onChange={(e) => setVerifier(i, { command: e.target.value })} placeholder="e.g. npm test" />
              </Field>
            ) : (
              <div className="row">
                <Field label="Provider">
                  <select className="input" value={v.provider || ''} onChange={(e) => setVerifier(i, { provider: e.target.value || null })}>
                    <option value="">(none)</option>
                    {STEP_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="Model">
                  <ModelSelect provider={v.provider} model={v.model || null} models={models} onChange={(m) => setVerifier(i, { model: m })} />
                </Field>
              </div>
            )}
            <Field label="Prompt">
              <textarea className="input mono" rows={2} value={v.prompt} onChange={(e) => setVerifier(i, { prompt: e.target.value })} placeholder="Optional verifier instructions" />
            </Field>
            <div className="verify-actions">
              <button type="button" className="btn small danger" onClick={() => onChange(verifiers.filter((_, x) => x !== i))}>Remove</button>
            </div>
          </div>
        ))}
    </div>
  );
}

// One editable step card.
function StepCard({ step, index, count, onPatch, onMoveUp, onMoveDown, onDelete, models, methods, pipelineId, onApplyRestore }) {
  const set = (patch) => onPatch(index, patch);

  return (
    <div className="step-card card">
      <div className="step-head">
        <span className="step-index mono">{index + 1}</span>
        <input
          className="input step-name"
          value={step.name}
          placeholder="Step name"
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="step-order">
          <button type="button" className="btn small ghost" disabled={index === 0} onClick={() => onMoveUp(index)}>↑</button>
          <button type="button" className="btn small ghost" disabled={index === count - 1} onClick={() => onMoveDown(index)}>↓</button>
          <button type="button" className="btn small danger" onClick={() => onDelete(index)}>✕</button>
        </span>
      </div>

      <MethodSelect value={step.method} onChange={(m) => set({ method: m })} methods={methods} />

      <div className="row">
        <Field label="Harness">
          <select className="input" value={step.harness} onChange={(e) => set({ harness: e.target.value })}>
            {STEP_HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </Field>
        <Field label="On failure">
          <select className="input" value={step.on_failure} onChange={(e) => set({ on_failure: e.target.value })}>
            <option value="stop">stop</option>
            <option value="continue">continue</option>
          </select>
        </Field>
        <Field label="Iterations">
          <input type="number" min={1} className="input" value={step.iterations} onChange={(e) => set({ iterations: Number(e.target.value) || 1 })} />
        </Field>
      </div>

      {step.harness === 'custom' ? (
        <Field label="Command">
          <input className="input mono" value={step.command} onChange={(e) => set({ command: e.target.value })} placeholder="e.g. npm run build" />
        </Field>
      ) : (
        <div className="row">
          <Field label="Provider">
            <select className="input" value={step.provider || ''} onChange={(e) => set({ provider: e.target.value || null })}>
              <option value="">(none)</option>
              {STEP_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <ModelSelect provider={step.provider} model={step.model || null} models={models} onChange={(m) => set({ model: m })} />
          </Field>
        </div>
      )}

      <Field label="Prompt">
        <textarea className="input mono" rows={2} value={step.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Optional step instructions for the agent" />
      </Field>
      <PromptEditor pipelineId={pipelineId} stepId={step.id} prompt={step.prompt} notify={onNotify} onApplyRestore={(text) => set({ prompt: text })} />

      <VerifierList
        verifiers={step.verify || []}
        onChange={(verify) => set({ verify })}
        models={models}
        methods={methods}
      />
    </div>
  );
}

export default function StepsBuilder({ steps, onChange, onSave, saving, saveLabel = 'Save steps', models, methods, pipelineId, onNotify }) {
  const list = Array.isArray(steps) ? steps : defaultSteps();

  const patch = (i, patchObj) => {
    const next = [...list];
    next[i] = { ...next[i], ...patchObj };
    onChange(next);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i) => onChange(list.filter((_, x) => x !== i));

  return (
    <div className="steps-builder">
      <div className="flow-hint mono" title="Pipeline flow">
        <span className="flow-glyph">▸</span> {flowHint(list)}
      </div>

      <div className="steps-list">
        {list.map((s, i) => (
          <StepCard
            key={s.id || i}
            step={s}
            index={i}
            count={list.length}
            onPatch={patch}
            onMoveUp={(idx) => move(idx, -1)}
            onMoveDown={(idx) => move(idx, 1)}
            onDelete={remove}
            models={models}
            methods={methods}
            pipelineId={pipelineId}
            onNotify={onNotify}
          />
        ))}
      </div>

      <div className="steps-actions">
        <button type="button" className="btn" onClick={() => onChange([...list, emptyStep('step')])}>+ Add step</button>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}