import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { adminApi, apiErrorMessage, type JobHealth, type JobState, type SystemReport, type SystemStatus } from '../../lib/adminApi';
import Button, { buttonStyle } from '../../components/admin/Button';
import Chip from '../../components/admin/Chip';
import DataTable, { type DataTableColumn } from '../../components/admin/DataTable';
import Sparkline from '../../components/admin/Sparkline';
import { EMPTY, formatDateTime, formatHour, formatPercent } from '../../components/admin/format';

const STATUS_BANNER: Record<SystemStatus, { text: string; background: string }> = {
  operational: { text: 'All systems operational', background: 'var(--c-success-bg)' },
  degraded: { text: 'Degraded performance', background: 'var(--c-warning-bg)' },
  outage: { text: 'Outage', background: 'var(--c-danger-bg)' },
};

const JOB_STATE_LABEL: Record<JobState, string> = {
  ok: 'OK',
  failed: 'Failed',
  stale: 'Stale',
  never: 'Never run',
};

const sectionStyle: CSSProperties = {
  padding: 'var(--sp-4)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
};

const sectionHeading: CSSProperties = { margin: '0 0 var(--sp-3)', fontSize: 16, fontWeight: 600, color: 'var(--c-text)' };

const ms = (v: number) => `${Math.round(v)} ms`;

function JobStateChip({ state }: { state: JobState }) {
  const amber = state === 'failed' || state === 'stale';
  return (
    <Chip background={amber ? 'var(--c-warning-bg)' : state === 'ok' ? 'var(--c-success-bg)' : undefined}>
      {JOB_STATE_LABEL[state]}
    </Chip>
  );
}

const JOB_COLUMNS: Array<DataTableColumn<JobHealth>> = [
  { key: 'label', header: 'Job', render: (j) => j.label },
  { key: 'lastRunAt', header: 'Last run', render: (j) => (j.lastRunAt ? formatDateTime(j.lastRunAt) : 'Never') },
  { key: 'lastOkAt', header: 'Last success', render: (j) => (j.lastOkAt ? formatDateTime(j.lastOkAt) : 'Never') },
  {
    key: 'state',
    header: 'Status',
    width: 200,
    render: (j) =>
      j.errorMsg && j.state === 'failed' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' }}>
          <JobStateChip state={j.state} />
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--c-text-2)' }}>Error</summary>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{j.errorMsg}</div>
          </details>
        </div>
      ) : (
        <JobStateChip state={j.state} />
      ),
    title: (j) => (j.errorMsg ? j.errorMsg : JOB_STATE_LABEL[j.state]),
  },
];

interface TileProps {
  label: string;
  value: string;
  chart: ReactNode;
}

function MetricTile({ label, value, chart }: TileProps) {
  return (
    <div style={{ ...sectionStyle, display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--c-text-2)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, lineHeight: '32px', color: 'var(--c-text)' }}>{value}</div>
      {chart}
    </div>
  );
}

export default function SystemPage() {
  const [report, setReport] = useState<SystemReport | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.system();
      if (id !== req.current) return;
      setReport(res);
      setFetchedAt(new Date());
    } catch (err) {
      if (id === req.current) setError(apiErrorMessage(err, 'Could not load system status.'));
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshButton = (
    <Button disabled={loading} onClick={() => void load()}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </Button>
  );

  const banner = report ? STATUS_BANNER[report.status] : null;
  const metrics = report?.requestMetrics;
  const last = metrics?.lastFullHour ?? null;
  const hours = metrics?.hours ?? [];

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', maxWidth: 1100 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--sp-2) var(--sp-4)',
          padding: 'var(--sp-3) var(--sp-4)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--c-border)',
          background: banner ? banner.background : 'var(--c-surface)',
        }}
      >
        <span role="status" style={{ fontSize: 16, fontWeight: 600, color: 'var(--c-text)' }}>
          {banner ? banner.text : loading ? 'Checking system status…' : 'System status unavailable'}
        </span>
        {fetchedAt && <span style={{ color: 'var(--c-text-2)' }}>Updated {formatDateTime(fetchedAt)}</span>}
        <span style={{ marginLeft: 'auto' }}>{refreshButton}</span>
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {error} Use Refresh to try again.
        </p>
      )}

      {report && metrics && (
        <>
          <section style={sectionStyle}>
            <h2 style={sectionHeading}>Database</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2) var(--sp-5)' }}>
              <span>
                <span style={{ color: 'var(--c-text-2)' }}>Status: </span>
                <span style={{ fontWeight: 600, color: report.database.ok ? 'var(--c-text)' : 'var(--c-danger)' }}>
                  {report.database.ok ? 'Connected' : 'Unreachable'}
                </span>
              </span>
              <span>
                <span style={{ color: 'var(--c-text-2)' }}>Latency: </span>
                <span style={{ fontWeight: 600 }}>
                  {report.database.latencyMs === null ? EMPTY : `${report.database.latencyMs} ms`}
                </span>
              </span>
            </div>
          </section>

          <section>
            <h2 style={sectionHeading}>Response times</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--sp-3)' }}>
              <MetricTile
                label="Median response time (p50)"
                value={last && last.p50Ms !== null ? ms(last.p50Ms) : EMPTY}
                chart={
                  <Sparkline
                    ariaLabel="Median response time (p50), last 24 hours"
                    formatValue={ms}
                    data={hours.map((h) => ({ label: formatHour(h.hourStart), value: h.p50Ms }))}
                  />
                }
              />
              <MetricTile
                label="95th percentile response time (p95)"
                value={last && last.p95Ms !== null ? ms(last.p95Ms) : EMPTY}
                chart={
                  <Sparkline
                    ariaLabel="95th percentile response time (p95), last 24 hours"
                    formatValue={ms}
                    data={hours.map((h) => ({ label: formatHour(h.hourStart), value: h.p95Ms }))}
                  />
                }
              />
              <MetricTile
                label="Error rate (% of requests returning 5xx)"
                value={last ? formatPercent(last.errorRate) : EMPTY}
                chart={
                  <Sparkline
                    ariaLabel="Error rate (% of requests returning 5xx), last 24 hours"
                    formatValue={(v) => formatPercent(v)}
                    data={hours.map((h) => ({ label: formatHour(h.hourStart), value: h.count ? h.errors5xx / h.count : 0 }))}
                  />
                }
              />
            </div>
            <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>
              Counting since {formatDateTime(metrics.since)}
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionHeading}>Errors</h2>
            {report.sentry.issuesUrl || report.sentry.performanceUrl ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                {report.sentry.issuesUrl && (
                  <a href={report.sentry.issuesUrl} target="_blank" rel="noopener noreferrer" style={buttonStyle('secondary')}>
                    Open Sentry issues
                  </a>
                )}
                {report.sentry.performanceUrl && (
                  <a href={report.sentry.performanceUrl} target="_blank" rel="noopener noreferrer" style={buttonStyle('secondary')}>
                    Open Sentry performance
                  </a>
                )}
              </div>
            ) : (
              <p style={{ margin: 0, color: 'var(--c-text-3)' }}>Sentry links aren't configured</p>
            )}
          </section>

          <section>
            <h2 style={sectionHeading}>Jobs</h2>
            <div style={{ ...sectionStyle, padding: 0, overflow: 'hidden' }}>
              <DataTable
                columns={JOB_COLUMNS}
                rows={report.jobs}
                rowKey={(j) => j.jobKey}
                emptyText="No jobs registered."
                loading={loading}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
