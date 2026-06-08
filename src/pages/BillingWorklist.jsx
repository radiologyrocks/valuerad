import React, { useEffect, useState, useCallback } from 'react';
import {
  FileWarning,
  ExternalLink,
  Sparkles,
  Send,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

const STATUS_VARIANT = {
  open: 'destructive',
  in_progress: 'secondary',
  resolved: 'default',
};

const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

function CategoryBadge({ category }) {
  const label = (category || 'other').replace(/_/g, ' ');
  return <Badge variant="outline" className="capitalize">{label}</Badge>;
}

export default function BillingWorklist() {
  const [exceptions, setExceptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const { exceptions } = await api.listExceptions();
      setExceptions(exceptions);
      if (!selectedId && exceptions.length) {
        setSelectedId(exceptions.find((e) => e.status !== 'resolved')?.id ?? exceptions[0].id);
      }
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { loadList(); /* eslint-disable-line */ }, []);

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <header className="border-b bg-background px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileWarning className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Billing Exception Worklist</h1>
            <p className="text-xs text-muted-foreground">
              MBMS exceptions → drafted addendum → PowerScribe
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 p-4 lg:p-6">
        {/* Worklist */}
        <div className="space-y-2">
          {listError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {listError}
            </div>
          )}
          {loading && !exceptions.length && (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading exceptions…
            </div>
          )}
          {exceptions.map((ex) => (
            <button
              key={ex.id}
              onClick={() => setSelectedId(ex.id)}
              className={`w-full text-left rounded-lg border p-3 transition-colors ${
                selectedId === ex.id ? 'border-primary bg-primary/5' : 'bg-background hover:bg-accent'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">#{ex.exceptionNumber}</span>
                <Badge variant={STATUS_VARIANT[ex.status]}>{STATUS_LABEL[ex.status]}</Badge>
              </div>
              <div className="mt-1 text-sm">{ex.studyDescription}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {ex.patient?.name} · Acc {ex.accessionNumber} · {ex.payer}
              </div>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div>
          {selectedId ? (
            <ExceptionDetail key={selectedId} id={selectedId} onResolved={loadList} />
          ) : (
            <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
              Select an exception to begin.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExceptionDetail({ id, onResolved }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [draftText, setDraftText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewReason, setReviewReason] = useState('');
  const [draftModel, setDraftModel] = useState('');

  const [pushing, setPushing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setDraftText('');
    setNeedsReview(false);
    setReviewReason('');
    setToast('');
    api.getException(id)
      .then((d) => { if (active) setDetail(d); })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  const handleDraft = async () => {
    setDrafting(true);
    setError('');
    setToast('');
    try {
      const result = await api.draftAddendum(id);
      setDraftText(result.addendum);
      setNeedsReview(result.needsReview);
      setReviewReason(result.reviewReason);
      setDraftModel(result.model);
    } catch (e) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setError('');
    try {
      await api.pushAddendum(id, draftText);
      setToast('Draft addendum pushed to PowerScribe for review and signature.');
    } catch (e) {
      setError(e.message);
    } finally {
      setPushing(false);
    }
  };

  const handleResolve = async () => {
    setResolving(true);
    setError('');
    try {
      await api.resolve(id, draftText);
      setToast('Exception marked resolved.');
      onResolved?.();
      const refreshed = await api.getException(id);
      setDetail(refreshed);
    } catch (e) {
      setError(e.message);
    } finally {
      setResolving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error && !detail) {
    return <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>;
  }
  if (!detail) return null;

  const { exception, report, launchUrl, epic } = detail;
  const launchConfigured = launchUrl && !launchUrl.startsWith('#');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-xl">
              {exception.studyDescription}{' '}
              <span className="text-base font-normal text-muted-foreground">({exception.modality})</span>
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Exception #{exception.exceptionNumber}</span>
              <span>·</span>
              <span>Acc {exception.accessionNumber}</span>
              <span>·</span>
              <span>CPT {exception.cptCode}</span>
              <CategoryBadge category={exception.category} />
            </div>
          </div>
          <Badge variant={STATUS_VARIANT[exception.status]}>{STATUS_LABEL[exception.status]}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div><span className="text-muted-foreground">Patient:</span> {exception.patient?.name}</div>
            <div><span className="text-muted-foreground">MRN:</span> {exception.patient?.mrn}</div>
            <div><span className="text-muted-foreground">DOS:</span> {exception.dateOfService}</div>
            <div><span className="text-muted-foreground">Payer:</span> {exception.payer}</div>
          </div>

          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-amber-900">
              <AlertTriangle className="h-4 w-4" /> Billing flagged
            </div>
            <p className="mt-1 text-amber-900/90">{exception.reason}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              asChild={launchConfigured}
              disabled={!launchConfigured}
              title={launchConfigured ? 'Open the study in PowerScribe' : 'Launch target not configured'}
            >
              {launchConfigured ? (
                <a href={launchUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> Launch study
                </a>
              ) : (
                <span><ExternalLink className="h-4 w-4" /> Launch study</span>
              )}
            </Button>
            {epic?.imagingStudyId && (
              <Badge variant="secondary">Epic ImagingStudy linked</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Report */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Signed report
            {report?.signedBy && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {report.signedBy}{report.status ? ` · ${report.status}` : ''}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {report?.text ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed font-mono">
              {report.text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              No PowerScribe report text found for this accession.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Addendum */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">Addendum</CardTitle>
          <Button size="sm" onClick={handleDraft} disabled={drafting || !report?.text}>
            {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {draftText ? 'Re-draft' : 'Draft with Claude'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {needsReview && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" /> Needs radiologist confirmation
              </div>
              <p className="mt-1">{reviewReason}</p>
            </div>
          )}

          <Textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="Click “Draft with Claude” to generate an addendum grounded in the signed report, then review and edit before pushing."
            className="min-h-[160px] font-mono text-sm"
          />
          {draftModel && (
            <p className="text-xs text-muted-foreground">
              Drafted by {draftModel}. Review and edit — a radiologist always signs in PowerScribe.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handlePush} disabled={pushing || !draftText.trim()}>
              {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Push draft to PowerScribe
            </Button>
            <Button variant="secondary" onClick={handleResolve} disabled={resolving || exception.status === 'resolved'}>
              {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Mark resolved
            </Button>
          </div>

          {toast && (
            <div className="rounded-md border border-green-300/60 bg-green-50 p-3 text-sm text-green-800 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> {toast}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
