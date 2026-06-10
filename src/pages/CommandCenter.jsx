import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { Activity, Bot, BarChart3, AlertTriangle, CheckCircle2, Clock, ShieldAlert, Hospital } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiPost, apiGet, API_BASE } from '@/lib/api.js';

function patientName(patient) {
  const n = patient?.name?.[0];
  if (!n) return null;
  return [n.given?.join(' '), n.family].filter(Boolean).join(' ') || n.text || null;
}

// Demo domain context the agent's read tools operate on when no live EHR
// session is attached. With a SMART session, the backend swaps these for real
// Epic reads automatically.
const DEMO_DATA = {
  slots: [
    { id: 'mr-0900', start: '2026-06-15T09:00:00Z', end: '2026-06-15T09:45:00Z', modality: 'MR' },
    { id: 'mr-1030', start: '2026-06-15T10:30:00Z', end: '2026-06-15T11:15:00Z', modality: 'MR' },
  ],
  coverage: { status: 'active', period: { start: '2026-01-01', end: '2026-12-31' } },
  waitlist: [
    { patientId: 'p-204', modality: 'MR', priority: 2, addedAt: '2026-06-01T00:00:00Z' },
    { patientId: 'p-118', modality: 'MR', priority: 1, addedAt: '2026-05-20T00:00:00Z' },
  ],
  radiologists: [
    { id: 'dr-neuro', subspecialties: ['neuro'], currentLoad: 4, capacity: 10, onShift: true },
    { id: 'dr-msk', subspecialties: ['msk'], currentLoad: 1, capacity: 10, onShift: true },
  ],
  auths: {},
};

const DEMO_BI = {
  slots: [
    { durationMin: 45, status: 'completed' }, { durationMin: 45, status: 'booked' },
    { durationMin: 45, status: 'open' }, { durationMin: 45, status: 'noshow' },
  ],
  appointments: [
    { status: 'completed' }, { status: 'completed' }, { status: 'noshow' }, { status: 'cancelled' },
  ],
  auths: [{ status: 'approved' }, { status: 'approved' }, { status: 'denied' }, { status: 'pending' }],
  studies: [{ modality: 'MR' }, { modality: 'CT' }, { modality: 'CT' }, { modality: 'US' }],
  marginByModality: { MR: 1200, CT: 800, US: 250 },
  claims: [
    { payer: 'Aetna', expected: 5000, paid: 4950 },
    { payer: 'BCBS', expected: 4000, paid: 3200 },
  ],
};

const PRESETS = [
  'A patient needs an MRI of the brain. Verify eligibility, check no-show risk, find the best slot, and recommend next steps.',
  'A CT slot just opened at 10:30. Find the best waitlist patient to backfill it.',
  'Route a completed neuro MRI study to the right radiologist.',
];

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm font-medium">{label}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

const CommandCenter = () => {
  const [task, setTask] = useState(PRESETS[0]);
  const [mode, setMode] = useState('recommend');
  const [agentResult, setAgentResult] = useState(null);
  const [agentError, setAgentError] = useState(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [snapshot, setSnapshot] = useState(null);
  const [biError, setBiError] = useState(null);
  const [biLoading, setBiLoading] = useState(false);

  // EHR launch context — present when Epic launched us into this view.
  const [session, setSession] = useState(null);
  const [ehr, setEhr] = useState(null);

  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get('session');
    if (!sid) return;
    setSession(sid);
    apiGet(`/epic/context?session=${encodeURIComponent(sid)}`)
      .then(setEhr)
      .catch(() => setEhr(null));
  }, []);

  const runAgent = async () => {
    setAgentLoading(true);
    setAgentError(null);
    setAgentResult(null);
    try {
      // When launched from Epic, send the live data (no demo fallback) and the
      // session so the agent's tools read the real chart.
      const body = session ? { task, mode } : { task, mode, data: DEMO_DATA };
      const result = await apiPost('/api/agent/run', body, { session });
      setAgentResult(result);
    } catch (err) {
      setAgentError(err.status === 503
        ? 'The agent needs an ANTHROPIC_API_KEY on the backend (and a signed BAA before any PHI). Set it and try again.'
        : err.message);
    } finally {
      setAgentLoading(false);
    }
  };

  const loadSnapshot = async () => {
    setBiLoading(true);
    setBiError(null);
    setSnapshot(null);
    try {
      setSnapshot(await apiPost('/api/bi/snapshot', DEMO_BI));
    } catch (err) {
      setBiError(err.message);
    } finally {
      setBiLoading(false);
    }
  };

  return (
    <>
      <Helmet><title>ValueRad — Command Center</title></Helmet>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex items-center gap-3 mb-2">
          <Activity className="w-7 h-7 text-primary" />
          <h1 className="text-3xl md:text-4xl font-bold" style={{ letterSpacing: '-0.02em' }}>Command Center</h1>
        </div>
        <p className="text-muted-foreground mb-6 max-w-3xl">
          Drives the live backend ({API_BASE || 'same origin'}). The agent runs in{' '}
          <span className="font-medium">recommend mode</span> by default — it proposes actions, never mutates,
          until a capability earns autonomy. With a SMART session attached, its read tools hit the real EHR.
        </p>

        {session && (
          <div className="mb-8 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <Hospital className="w-5 h-5 text-primary shrink-0" />
            <div className="text-sm">
              <span className="font-medium">Launched from Epic.</span>{' '}
              {ehr?.patient
                ? <>Patient context: <span className="font-medium">{patientName(ehr.patient) || ehr.patientId}</span>{ehr.encounterId ? ` · encounter ${ehr.encounterId}` : ''}. Agent tools are reading live EHR data.</>
                : <>Session active — agent tools will read live EHR data.</>}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Agent */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2"><Bot className="w-5 h-5 text-primary" /><CardTitle className="text-xl">Operations agent</CardTitle></div>
              <CardDescription>Scheduling, eligibility, prior-auth and worklist routing — guardrail-gated.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} className="text-foreground" />
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p, i) => (
                  <button key={i} onClick={() => setTask(p)} className="text-xs px-2 py-1 rounded-full border hover:bg-muted transition-colors">
                    Preset {i + 1}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <select value={mode} onChange={(e) => setMode(e.target.value)} className="border rounded-md px-3 py-2 text-sm bg-background">
                  <option value="recommend">Recommend (safe)</option>
                  <option value="autonomous">Autonomous</option>
                </select>
                <Button onClick={runAgent} disabled={agentLoading}>{agentLoading ? 'Running…' : 'Run agent'}</Button>
              </div>

              {agentError && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{agentError}</span>
                </div>
              )}

              {agentResult && (
                <div className="space-y-3 text-sm">
                  {agentResult.summary && (
                    <div className="rounded-md bg-muted/50 p-3"><span className="font-medium">Summary:</span> {agentResult.summary}</div>
                  )}
                  <ResultList icon={Clock} title="Proposed (awaiting approval)" items={agentResult.proposals} tone="amber" />
                  <ResultList icon={CheckCircle2} title="Executed" items={agentResult.executed} tone="green" />
                  <ResultList icon={ShieldAlert} title="Blocked by guardrails" items={agentResult.blocked} tone="red" />
                </div>
              )}
            </CardContent>
          </Card>

          {/* BI */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" /><CardTitle className="text-xl">Executive snapshot</CardTitle></div>
              <CardDescription>Utilization, no-shows, auth performance, modality mix, payer leakage.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={loadSnapshot} disabled={biLoading}>{biLoading ? 'Loading…' : 'Load snapshot'}</Button>
              {biError && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{biError}</span>
                </div>
              )}
              {snapshot && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Scanner utilization" value={`${snapshot.utilization.utilizationPct}%`} sub={`${snapshot.utilization.usedMinutes}/${snapshot.utilization.totalMinutes} min`} />
                    <Stat label="No-show rate" value={`${snapshot.noShow.noShowPct}%`} sub={`${snapshot.noShow.cancelPct}% cancels`} />
                    <Stat label="Auth approval" value={`${snapshot.auth.approvalPct}%`} sub={`${snapshot.auth.denialPct}% denied`} />
                    <Stat label="Est. margin" value={`$${snapshot.modality.estimatedMargin}`} sub={`${snapshot.modality.total} studies`} />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">Modality mix</div>
                    <div className="flex flex-wrap gap-2">
                      {snapshot.modality.mix.map((m) => (
                        <Badge key={m.modality} variant="secondary">{m.modality}: {m.sharePct}%</Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">Payer leakage</div>
                    <div className="space-y-1">
                      {snapshot.payerLeakage.map((p) => (
                        <div key={p.payer} className="flex items-center justify-between text-sm">
                          <span>{p.payer}</span>
                          <span className={p.flagged ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                            ${p.shortfall} short ({p.shortfallPct}%){p.flagged ? ' ⚠' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
};

function ResultList({ icon: Icon, title, items, tone }) {
  if (!items || items.length === 0) return null;
  const toneCls = { amber: 'text-amber-600', green: 'text-green-600', red: 'text-destructive' }[tone] || '';
  return (
    <div>
      <div className={`flex items-center gap-1.5 font-medium ${toneCls}`}><Icon className="w-4 h-4" />{title} ({items.length})</div>
      <ul className="mt-1 space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="font-mono text-xs">{it.tool}</span>{it.reason ? ` — ${it.reason}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default CommandCenter;
