import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { Activity, Bot, BarChart3, AlertTriangle, CheckCircle2, Clock, ShieldAlert, Hospital, Gauge, Upload, Database, Sparkles, Play, RotateCcw, PackagePlus, ScanLine, Camera } from 'lucide-react';
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

const DATASETS = ['claims', 'appointments', 'studies', 'slots', 'referrals', 'referrals_prior'];

const SAMPLE_CSV = {
  claims: 'payer,status,expected,paid,arDays,denialReason\nAetna,paid,1000,1000,20,\nBCBS,denied,1200,0,95,No prior auth\nCigna,paid,800,640,42,',
  slots: 'durationMin,status\n45,completed\n45,booked\n45,open\n45,noshow',
  studies: 'modality,orderedAt,finalAt,radiologistId,rvu\nMR,2026-06-01T00:00:00Z,2026-06-01T30:00:00Z,dr-neuro,2.5\nCT,2026-06-01T00:00:00Z,2026-06-01T10:00:00Z,dr-body,1.8',
  referrals: 'referrerId,referrerName\nr1,Dr A\nr1,Dr A\nr3,Dr C',
  referrals_prior: 'referrerId,referrerName\nr1,Dr A\nr1,Dr A\nr1,Dr A\nr2,Dr B',
  appointments: 'status\ncompleted\ncompleted\nnoshow\ncancelled',
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

  // CEO scorecard + warehouse ingestion.
  const [dataset, setDataset] = useState('claims');
  const [csvText, setCsvText] = useState(SAMPLE_CSV.claims);
  const [ingestMsg, setIngestMsg] = useState(null);
  const [counts, setCounts] = useState(null);
  const [card, setCard] = useState(null);
  const [cardError, setCardError] = useState(null);
  const [cardLoading, setCardLoading] = useState(false);

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

  useEffect(() => { refreshCounts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        ? `${err.message} (A signed BAA is required before any PHI; the subscription dev transport refuses live EHR sessions for that reason.)`
        : err.message);
    } finally {
      setAgentLoading(false);
    }
  };

  const refreshCounts = async () => {
    try { setCounts((await apiGet('/api/bi/warehouse')).counts); } catch { /* backend offline */ }
  };

  const ingestCsv = async () => {
    setIngestMsg(null);
    try {
      const r = await apiPost('/api/bi/ingest', { dataset, format: 'csv', csv: csvText, replace: true });
      setIngestMsg({ ok: true, text: `Ingested ${r.ingested} ${dataset} rows (${r.backend}).` });
      refreshCounts();
    } catch (err) {
      setIngestMsg({ ok: false, text: err.message });
    }
  };

  const onCsvFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result));
    reader.readAsText(file);
  };

  const loadScorecard = async () => {
    setCardLoading(true);
    setCardError(null);
    setCard(null);
    try {
      setCard(await apiPost('/api/bi/scorecard', { source: 'warehouse' }));
    } catch (err) {
      setCardError(err.message);
    } finally {
      setCardLoading(false);
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

        {/* CEO scorecard + warehouse ingestion */}
        <Card className="mt-6">
          <CardHeader>
            <div className="flex items-center gap-2"><Gauge className="w-5 h-5 text-primary" /><CardTitle className="text-xl">CEO scorecard</CardTitle></div>
            <CardDescription>
              KPIs vs targets with exception alerts. Feed it CSV extracts (RCM, RIS, payer remits) or a warehouse — same metric engine.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Ingest */}
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Database className="w-4 h-4" /> Ingest data</div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={dataset} onChange={(e) => { setDataset(e.target.value); setCsvText(SAMPLE_CSV[e.target.value] || ''); }} className="border rounded-md px-3 py-2 text-sm bg-background">
                  {DATASETS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <label className="text-sm inline-flex items-center gap-1.5 px-3 py-2 border rounded-md cursor-pointer hover:bg-muted">
                  <Upload className="w-4 h-4" /> Choose CSV
                  <input type="file" accept=".csv,text/csv" onChange={onCsvFile} className="hidden" />
                </label>
                <Button onClick={ingestCsv} variant="secondary">Ingest</Button>
                {counts && <span className="text-xs text-muted-foreground">Loaded: {Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing yet'}</span>}
              </div>
              <Textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={4} className="text-foreground font-mono text-xs" />
              {ingestMsg && (
                <div className={`text-sm ${ingestMsg.ok ? 'text-green-600' : 'text-destructive'}`}>{ingestMsg.text}</div>
              )}
            </div>

            {/* Scorecard */}
            <div>
              <Button onClick={loadScorecard} disabled={cardLoading}>{cardLoading ? 'Computing…' : 'Load scorecard'}</Button>
              {cardError && (
                <div className="mt-3 flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{cardError}</span>
                </div>
              )}
              {card && (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {card.kpis.map((k) => <KpiTile key={k.key} kpi={k} />)}
                  </div>
                  {card.exceptions.length > 0 && (
                    <div>
                      <div className="text-sm font-medium mb-1 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 text-amber-600" /> Exception alerts</div>
                      <ul className="space-y-1">
                        {card.exceptions.map((e) => (
                          <li key={e.key} className={`text-sm ${e.severity === 'high' ? 'text-destructive' : 'text-amber-600'}`}>• {e.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <LivingFeatures />
        <Supplies />
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Supplies — UDI/GS1 scanning (phone camera or wedge scanner, same intake)
// and gated automated ordering. See docs/SUPPLY_CHAIN.md.
// ---------------------------------------------------------------------------

function Supplies() {
  const [code, setCode] = useState('');
  const [action, setAction] = useState('use');
  const [items, setItems] = useState([]);
  const [orders, setOrders] = useState([]);
  const [msg, setMsg] = useState(null);
  const [unknown, setUnknown] = useState(null); // parsed payload of an unregistered GTIN
  const [reg, setReg] = useState({ name: '', parLevel: 10, reorderPoint: 4, packSize: 1, unitCost: 0, restricted: false });
  const [scanning, setScanning] = useState(false);
  const videoRef = React.useRef(null);
  const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  const refresh = async () => {
    try {
      const r = await apiGet('/api/supplies');
      setItems(r.items);
      setOrders(r.openOrders);
    } catch { /* backend offline */ }
  };
  useEffect(() => { refresh(); }, []);

  const submitScan = async (value) => {
    setMsg(null);
    setUnknown(null);
    try {
      const r = await apiPost('/api/supplies/scan', { code: value, action });
      setMsg({
        ok: true,
        text: `${action === 'use' ? 'Used' : 'Received'} ${r.qty} × ${r.item.name} — on hand ${r.stock.onHand}` +
          (r.reorder ? ` · auto-proposed order #${r.reorder.id} ($${r.reorder.total_cost})${r.reorder.status === 'approved' ? ' — auto-approved by gates' : ' — awaiting confirmation'}` : ''),
      });
      setCode('');
      refresh();
    } catch (err) {
      if (err.status === 404 && err.data?.parsed) {
        setUnknown(err.data.parsed);
        setMsg({ ok: false, text: `Unknown item (GTIN ${err.data.parsed.gtin}) — register it below.` });
      } else {
        setMsg({ ok: false, text: err.message });
      }
    }
  };

  const registerItem = async () => {
    try {
      await apiPost('/api/supplies/items', {
        gtin: unknown.gtin, name: reg.name, par_level: Number(reg.parLevel),
        reorder_point: Number(reg.reorderPoint), pack_size: Number(reg.packSize),
        unit_cost: Number(reg.unitCost), restricted: reg.restricted,
      });
      setMsg({ ok: true, text: `Registered ${reg.name}. Scan it again to record stock.` });
      setUnknown(null);
      refresh();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  };

  const orderAction = async (o, act, label) => {
    try {
      await apiPost(`/api/supplies/orders/${o.id}/${act}`, {});
      setMsg({ ok: true, text: label });
      refresh();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  };

  // Phone-camera scanning via the BarcodeDetector API (DataMatrix is what
  // UDI labels carry). A wedge scanner needs none of this — it types into
  // the same input and submits on Enter.
  const startCamera = async () => {
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ['data_matrix', 'code_128', 'ean_13', 'upc_a', 'qr_code'] });
      const tick = async () => {
        if (!video.srcObject) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            stopCamera();
            setCode(codes[0].rawValue);
            await submitScan(codes[0].rawValue);
            return;
          }
        } catch { /* keep scanning */ }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (err) {
      setScanning(false);
      setMsg({ ok: false, text: `Camera unavailable: ${err.message}` });
    }
  };

  const stopCamera = () => {
    const video = videoRef.current;
    if (video?.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    setScanning(false);
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center gap-2"><ScanLine className="w-5 h-5 text-primary" /><CardTitle className="text-xl">Supplies</CardTitle></div>
        <CardDescription>
          Scan UDI/GS1 barcodes with the phone camera or any wedge scanner (it types into the same field).
          Consumption below the reorder point auto-proposes a gated order — restricted and high-dollar
          orders always wait for your confirmation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Scan intake */}
        <div className="flex flex-wrap items-center gap-2">
          <select value={action} onChange={(e) => setAction(e.target.value)} className="border rounded-md px-3 py-2 text-sm bg-background">
            <option value="use">Use (consume)</option>
            <option value="receive">Receive (stock in)</option>
          </select>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) submitScan(code.trim()); }}
            placeholder="Scan or type a GS1/UDI code… e.g. (01)00380740000011(17)270331(10)A123"
            className="flex-1 min-w-64 border rounded-md px-3 py-2 text-sm bg-background font-mono"
          />
          <Button onClick={() => code.trim() && submitScan(code.trim())} variant="secondary">Submit</Button>
          {cameraSupported && (
            <Button onClick={scanning ? stopCamera : startCamera} variant={scanning ? 'destructive' : 'default'}>
              <Camera className="w-4 h-4 mr-1" />{scanning ? 'Stop' : 'Camera'}
            </Button>
          )}
        </div>
        <video ref={videoRef} className={`rounded-lg border w-full max-w-sm ${scanning ? '' : 'hidden'}`} muted playsInline />
        {!cameraSupported && (
          <div className="text-xs text-muted-foreground">Camera scanning needs a Chromium-based browser (BarcodeDetector API); the input field works everywhere.</div>
        )}

        {msg && <div className={`text-sm rounded-md p-3 ${msg.ok ? 'bg-muted/50' : 'text-destructive bg-destructive/10'}`}>{msg.text}</div>}

        {/* Register an unknown item */}
        {unknown && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
            <div className="text-sm font-medium">Register GTIN {unknown.gtin}{unknown.lot ? ` (lot ${unknown.lot}${unknown.expiry ? `, exp ${unknown.expiry}` : ''})` : ''}</div>
            <div className="flex flex-wrap gap-2 text-sm">
              <input placeholder="Item name" value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} className="border rounded-md px-2 py-1.5 bg-background flex-1 min-w-48" />
              {[['parLevel', 'Par'], ['reorderPoint', 'Reorder at'], ['packSize', 'Pack'], ['unitCost', '$/unit']].map(([k, label]) => (
                <label key={k} className="flex items-center gap-1 text-xs text-muted-foreground">{label}
                  <input type="number" value={reg[k]} onChange={(e) => setReg({ ...reg, [k]: e.target.value })} className="border rounded-md px-2 py-1.5 w-20 bg-background text-foreground text-sm" />
                </label>
              ))}
              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={reg.restricted} onChange={(e) => setReg({ ...reg, restricted: e.target.checked })} /> restricted (always needs approval)</label>
            </div>
            <Button size="sm" onClick={registerItem} disabled={!reg.name}>Register</Button>
          </div>
        )}

        {/* Stock */}
        {items.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Stock ({items.length})</div>
            {items.map((s) => (
              <div key={s.itemId} className="flex flex-wrap items-center gap-2 text-sm rounded-lg border p-2.5">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground">on hand {s.onHand}{s.daysOfSupply != null ? ` · ~${s.daysOfSupply}d supply` : ''} · reorder at {s.reorderPoint}</span>
                {s.restricted && <Badge variant="secondary">restricted</Badge>}
                {s.belowReorder && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700">below reorder</span>}
                {s.expiring.length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/15 text-destructive">
                    {s.expiring.some((l) => l.expired) ? 'EXPIRED lot' : `expiring: ${s.expiring[0].expiry}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Open orders */}
        {orders.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Open orders ({orders.length})</div>
            {orders.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center gap-2 text-sm rounded-lg border p-2.5">
                <span className="font-medium">#{o.id} {o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</span>
                <span className="text-xs text-muted-foreground">${o.total_cost}{o.vendor ? ` · ${o.vendor}` : ''} · by {o.created_by}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${o.status === 'proposed' ? 'bg-amber-500/15 text-amber-700' : o.status === 'approved' ? 'bg-blue-500/15 text-blue-700' : 'bg-green-500/15 text-green-700'}`}>{o.status}</span>
                <span className="flex-1" />
                {o.status === 'proposed' && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => orderAction(o, 'approve', `Order #${o.id} confirmed.`)}><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Confirm</Button>
                    <Button size="sm" variant="ghost" onClick={() => orderAction(o, 'cancel', `Order #${o.id} cancelled.`)}>Cancel</Button>
                  </>
                )}
                {o.status === 'approved' && (
                  <Button size="sm" onClick={() => orderAction(o, 'place', `Order #${o.id} sent to vendor.`)}>Place</Button>
                )}
                {o.status === 'placed' && (
                  <Button size="sm" variant="secondary" onClick={() => orderAction(o, 'receive', `Order #${o.id} marked received — scan items in.`)}>Mark received</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Living features — request, approve, run, roll back (docs/LIVING_SOFTWARE.md)
// ---------------------------------------------------------------------------

const FEATURE_STATUS_VARIANT = {
  proposed: 'bg-amber-500/15 text-amber-700',
  canary: 'bg-blue-500/15 text-blue-700',
  active: 'bg-green-500/15 text-green-700',
  retired: 'bg-muted text-muted-foreground',
  rejected: 'bg-destructive/15 text-destructive',
};

function LivingFeatures() {
  const [spec, setSpec] = useState('A monthly denials-by-payer CSV I can upload to my billing portal.');
  const [features, setFeatures] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [busy, setBusy] = useState(null); // id of feature being acted on, or 'request'
  const [message, setMessage] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const refresh = async () => {
    try { setFeatures((await apiGet('/api/features')).features); } catch { /* backend offline */ }
    try { setCatalog((await apiGet('/api/features/catalog')).catalog); } catch { /* backend offline */ }
  };
  useEffect(() => { refresh(); }, []);

  const act = async (label, fn) => {
    setMessage(null);
    setRunResult(null);
    try {
      const out = await fn();
      setMessage({ ok: true, text: label });
      await refresh();
      return out;
    } catch (err) {
      setMessage({
        ok: false,
        text: err.status === 503
          ? `${err.message} (The builder never sees PHI — generation runs on schema + synthetic fixtures only, so a Claude Pro/Max dev login works here.)`
          : err.message,
      });
    } finally {
      setBusy(null);
    }
  };

  const requestFeature = () => {
    setBusy('request');
    act('Request sent to the builder.', async () => {
      const r = await apiPost('/api/features/request', { spec });
      setMessage({
        ok: true,
        text: r.proposed?.length
          ? `Builder proposed: ${r.proposed.map((f) => `${f.name} v${f.version}`).join(', ')} — awaiting your approval.`
          : (r.summary || 'The builder finished without a proposal.'),
      });
    });
  };

  const install = (key) => {
    setBusy(`install-${key}`);
    act(`Installed "${key}" as proposed — approve it to activate.`, () => apiPost(`/api/features/catalog/${key}/install`, {}));
  };

  const lifecycle = (f, action, label, body = {}) => {
    setBusy(f.id);
    act(label, () => apiPost(`/api/features/${f.id}/${action}`, body));
  };

  // Activation of a feature with an outcome rubric requires grading each
  // criterion — the review is recorded in the evidence and audit trail.
  const [grading, setGrading] = useState(null); // { feature, results: [bool] }

  const needsRubric = (f) =>
    Array.isArray(f.outcome?.rubric) && f.outcome.rubric.length > 0 &&
    (f.tier === 1 ? f.status === 'proposed' : f.status === 'canary');

  const approve = (f) => {
    if (needsRubric(f)) {
      setGrading({ feature: f, results: f.outcome.rubric.map(() => true) });
      return;
    }
    lifecycle(f, 'approve', f.tier === 2 && f.status === 'proposed' ? `${f.name} approved into canary.` : `${f.name} is now active.`);
  };

  const confirmGrading = () => {
    const { feature, results } = grading;
    setGrading(null);
    lifecycle(feature, 'approve', `${feature.name} is now active (rubric: ${results.filter(Boolean).length}/${results.length} satisfied).`, { rubricResults: results });
  };

  const run = (f) => {
    setBusy(f.id);
    act(`Ran ${f.name}.`, async () => {
      const r = await apiPost(`/api/features/${f.id}/run`, {});
      setRunResult({ feature: f, result: r.result ?? r });
    });
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" /><CardTitle className="text-xl">Living features</CardTitle></div>
        <CardDescription>
          Describe a report, export, payer rule pack, or ingest mapping — the builder composes it as declarative
          configuration (never code), tests it on synthetic fixtures, and queues it for your approval. Every step
          is an audit record; the builder never sees real data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Request box */}
        <div className="space-y-2">
          <Textarea value={spec} onChange={(e) => setSpec(e.target.value)} rows={2} className="text-foreground" />
          <Button onClick={requestFeature} disabled={busy === 'request'}>
            {busy === 'request' ? 'Building…' : 'Request feature'}
          </Button>
        </div>

        {message && (
          <div className={`text-sm rounded-md p-3 ${message.ok ? 'bg-muted/50' : 'text-destructive bg-destructive/10'}`}>{message.text}</div>
        )}

        {/* Certified catalog */}
        {catalog.length > 0 && (
          <div>
            <div className="text-sm font-medium mb-2 flex items-center gap-1.5"><PackagePlus className="w-4 h-4" /> Certified catalog</div>
            <div className="flex flex-wrap gap-2">
              {catalog.map((c) => (
                <button
                  key={c.featureKey}
                  onClick={() => install(c.featureKey)}
                  disabled={busy === `install-${c.featureKey}`}
                  title={c.spec}
                  className="text-xs px-2 py-1 rounded-full border hover:bg-muted transition-colors"
                >
                  + {c.definition.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Gallery / approval queue */}
        {features.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Features ({features.length})</div>
            {features.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
                <span className="font-medium">{f.name}</span>
                <span className="text-xs text-muted-foreground">v{f.version} · {f.kind} · tier {f.tier}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${FEATURE_STATUS_VARIANT[f.status] || ''}`}>{f.status}</span>
                {f.testEvidence && (
                  <span className={`text-xs ${f.testEvidence.ok ? 'text-green-600' : 'text-destructive'}`}>
                    golden {f.testEvidence.ok ? '✓' : '✗'}
                  </span>
                )}
                {f.attestation && (
                  <span className="text-xs text-green-700" title={`signed ${f.attestation.signedAt} by ${f.attestation.approvedBy} (${f.attestation.mode})`}>
                    signed ✓{f.attestation.mode === 'ephemeral-dev' ? ' (dev)' : ''}
                  </span>
                )}
                <span className="flex-1" />
                {f.status === 'proposed' && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy === f.id} onClick={() => approve(f)}>
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" />{f.tier === 2 ? 'Approve → canary' : 'Approve'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => lifecycle(f, 'reject', `${f.name} rejected.`)}>Reject</Button>
                  </>
                )}
                {f.status === 'canary' && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy === f.id} onClick={() => lifecycle(f, 'canary', `Canary report stored for ${f.name} — review it, then promote.`)}>
                      Shadow-evaluate
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy === f.id} onClick={() => approve(f)}>
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" />Promote
                    </Button>
                  </>
                )}
                {f.status === 'active' && (
                  <>
                    {(f.kind === 'report' || f.kind === 'export' || f.kind === 'ingest_mapper') && (
                      <Button size="sm" disabled={busy === f.id} onClick={() => run(f)}>
                        <Play className="w-3.5 h-3.5 mr-1" />Run
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => lifecycle(f, 'rollback', `${f.name} rolled back to the prior version.`)}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" />Roll back
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => lifecycle(f, 'retire', `${f.name} retired.`)}>Retire</Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Rubric grading — activation records this review in the attestation trail */}
        {grading && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
            <div className="text-sm font-medium">
              Grade the outcome rubric for “{grading.feature.name}” — does the feature actually do what was asked?
            </div>
            <div className="space-y-1.5">
              {grading.feature.outcome.rubric.map((criterion, i) => (
                <label key={i} className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={grading.results[i]}
                    onChange={(e) => setGrading({
                      ...grading,
                      results: grading.results.map((r, j) => (j === i ? e.target.checked : r)),
                    })}
                    className="mt-0.5"
                  />
                  <span>{criterion}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={confirmGrading}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                Activate ({grading.results.filter(Boolean).length}/{grading.results.length} satisfied)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setGrading(null)}>Cancel</Button>
            </div>
            <div className="text-xs text-muted-foreground">
              Your grading is recorded in the feature’s evidence and audit trail alongside the signed attestation.
            </div>
          </div>
        )}

        {/* Run output */}
        {runResult && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <div className="text-sm font-medium">{runResult.feature.name} — output</div>
            {runResult.result.format === 'csv' ? (
              <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">{runResult.result.csv}</pre>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-80 overflow-y-auto">{JSON.stringify(runResult.result, null, 2)}</pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_STYLES = {
  ok: 'border-green-500/40 bg-green-500/5',
  warn: 'border-amber-500/50 bg-amber-500/10',
  breach: 'border-destructive/50 bg-destructive/10',
};

function KpiTile({ kpi }) {
  const v = kpi.variancePct;
  return (
    <div className={`rounded-lg border p-3 ${STATUS_STYLES[kpi.status] || ''}`}>
      <div className="text-xl font-bold">{kpi.value}{kpi.unit}</div>
      <div className="text-xs font-medium">{kpi.label}</div>
      <div className="text-xs text-muted-foreground mt-1">
        target {kpi.target}{kpi.unit}{v != null ? ` · ${v > 0 ? '+' : ''}${v}%` : ''}
      </div>
    </div>
  );
}

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
