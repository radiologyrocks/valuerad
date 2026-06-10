/**
 * The certified feature catalog — the marketplace seed.
 *
 * Hand-written, golden-tested definitions that install into a tenant's
 * registry through the same propose → approve lifecycle as generated ones
 * (certification doesn't skip governance; it just means we wrote and support
 * them). Tenant-built features that prove out get promoted INTO this list.
 */

export const CATALOG = [
  {
    featureKey: 'ceo-scorecard-stretch',
    certified: true,
    spec: 'The standard CEO scorecard, but with stretch targets: 80% utilization, 6% no-shows, 3% denials.',
    definition: {
      kind: 'report',
      title: 'CEO scorecard (stretch targets)',
      blocks: [
        {
          id: 'card',
          metric: 'scorecard',
          params: {
            targets: {
              utilizationPct: { target: 80 },
              noShowPct: { target: 6 },
              denialPct: { target: 3 },
            },
          },
        },
      ],
      access: { roles: ['executive', 'admin'] },
    },
  },
  {
    featureKey: 'referrer-scorecard',
    certified: true,
    spec: 'A referrer-facing scorecard: top referrers and leakage vs prior period, plus report turnaround (referrers leave when reports are slow).',
    definition: {
      kind: 'report',
      title: 'Referrer scorecard',
      blocks: [
        { id: 'referrers', metric: 'referralAnalytics' },
        { id: 'turnaround', metric: 'turnaroundTime', params: { slaHours: 24 } },
      ],
      access: { roles: ['executive', 'admin'] },
    },
  },
  {
    featureKey: 'denials-by-payer-csv',
    certified: true,
    spec: 'Denied dollars by payer as a CSV for the billing portal.',
    definition: {
      kind: 'export',
      title: 'Denials by payer (CSV)',
      blocks: [{ id: 'denials', metric: 'denialAnalytics' }],
      output: {
        format: 'csv',
        from: 'denials.byPayer',
        columns: [
          { header: 'Payer', path: 'payer' },
          { header: 'Denied Claims', path: 'count' },
          { header: 'Denied Dollars', path: 'dollars' },
        ],
      },
      access: { roles: ['executive', 'admin'] },
    },
  },
  {
    featureKey: 'mr-turnaround-report',
    certified: true,
    spec: 'Turnaround for MR studies only, against a 12-hour SLA.',
    definition: {
      kind: 'report',
      title: 'MR turnaround (12h SLA)',
      blocks: [
        {
          id: 'tat',
          metric: 'turnaroundTime',
          params: { slaHours: 12 },
          filters: [{ dataset: 'studies', field: 'modality', op: 'eq', value: 'MR' }],
        },
      ],
      access: { roles: ['executive', 'admin', 'radiologist'] },
    },
  },
  {
    featureKey: 'medicare-imaging-rulepack',
    certified: true,
    spec: 'Per-contract auth rules for traditional Medicare: no prior auth for outpatient CT/MR; ultrasound never needs auth.',
    definition: {
      kind: 'rule_pack',
      title: 'Medicare imaging auth rules',
      payerRules: {
        Medicare: { exempt: ['CT', 'MR', 'MRI', 'US', 'XR'] },
      },
      access: { roles: ['auth_specialist', 'admin', 'executive'] },
    },
  },
  {
    featureKey: 'generic-rcm-claims-mapper',
    certified: true,
    spec: 'Maps the common RCM claims-export header set onto the claims dataset.',
    definition: {
      kind: 'ingest_mapper',
      title: 'Generic RCM claims mapper',
      dataset: 'claims',
      columns: {
        'Payer Name': 'payer',
        'Claim Status': 'status',
        'Billed Amount': 'expected',
        'Paid Amount': 'paid',
        'Days in AR': 'arDays',
        'Denial Reason': 'denialReason',
        'Modality': 'modality',
      },
      transforms: [
        { field: 'expected', op: 'number' },
        { field: 'paid', op: 'number' },
        { field: 'arDays', op: 'number' },
        { field: 'status', op: 'lowercase' },
        { field: 'modality', op: 'uppercase' },
      ],
      sampleCsv:
        'Payer Name,Claim Status,Billed Amount,Paid Amount,Days in AR,Denial Reason,Modality\n' +
        'Aetna,Paid,1000,1000,20,,MR\n' +
        'BCBS,Denied,1200,0,95,No prior auth,CT\n',
      access: { roles: ['executive', 'admin'] },
    },
  },
];

export function catalogEntry(featureKey) {
  return CATALOG.find((c) => c.featureKey === featureKey) ?? null;
}
