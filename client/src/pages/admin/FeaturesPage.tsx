import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  adminApi,
  apiErrorMessage,
  type FeatureUsage,
  type FeaturesReport,
  type MicroFeedbackStat,
} from '../../lib/adminApi';
import DataTable, { type DataTableColumn, type SortDirection } from '../../components/admin/DataTable';
import StatCard from '../../components/admin/StatCard';
import { EMPTY, formatNumber, formatPercent } from '../../components/admin/format';

type FeatureSortKey = 'label' | 'tier' | 'uses' | 'users' | 'pctOfActive';
const FEATURE_SORT_KEYS: FeatureSortKey[] = ['label', 'tier', 'uses', 'users', 'pctOfActive'];

const tableBox: CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  overflow: 'hidden',
};

const sectionHeading: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--c-text)' };

function compareFeatures(a: FeatureUsage, b: FeatureUsage, key: FeatureSortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv), 'en', { sensitivity: 'base' });
}

export default function FeaturesPage() {
  const [report, setReport] = useState<FeaturesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: FeatureSortKey; dir: SortDirection }>({ key: 'pctOfActive', dir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    adminApi
      .features()
      .then((res) => {
        if (cancelled) return;
        setReport(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(apiErrorMessage(err, 'Could not load feature usage.'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const features = useMemo(() => {
    if (!report) return [];
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...report.features].sort(
      (a, b) => sign * compareFeatures(a, b, sort.key) || a.label.localeCompare(b.label),
    );
  }, [report, sort]);

  const featureColumns: Array<DataTableColumn<FeatureUsage>> = [
    { key: 'label', header: 'Feature', sortable: true, render: (r) => r.label },
    { key: 'tier', header: 'Tier', sortable: true, width: 120, render: (r) => r.tier },
    {
      key: 'uses',
      header: 'Uses',
      sortable: true,
      defaultDir: 'desc',
      align: 'right',
      width: 110,
      render: (r) => formatNumber(r.uses),
    },
    {
      key: 'users',
      header: 'Users',
      sortable: true,
      defaultDir: 'desc',
      align: 'right',
      width: 110,
      render: (r) => formatNumber(r.users),
    },
    {
      key: 'pctOfActive',
      header: '% of active users',
      sortable: true,
      defaultDir: 'desc',
      align: 'right',
      width: 150,
      render: (r) => `${r.pctOfActive}%`,
    },
  ];

  const feedbackColumns: Array<DataTableColumn<MicroFeedbackStat>> = [
    { key: 'label', header: 'Trigger', render: (r) => r.label },
    { key: 'timesFired', header: 'Times fired', align: 'right', width: 130, render: (r) => formatNumber(r.timesFired) },
    {
      key: 'responses',
      header: 'Responses received',
      align: 'right',
      width: 170,
      render: (r) => formatNumber(r.responses),
    },
    {
      key: 'responseRate',
      header: 'Response rate',
      align: 'right',
      width: 140,
      render: (r) => formatPercent(r.responseRate),
    },
  ];

  const headline = report?.headline;

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <p style={{ margin: 0, color: 'var(--c-text-2)' }}>
        Last 30 days. Active users: {report ? formatNumber(report.activeUsers30d) : EMPTY}.
      </p>

      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--sp-3)' }}>
        <StatCard
          label="Canvas sessions"
          value={headline ? formatNumber(headline.canvasSessions) : EMPTY}
          sublabel="Last 30 days"
        />
        <StatCard
          label="Harvest entries logged"
          value={headline ? formatNumber(headline.harvestEntries) : EMPTY}
          sublabel="Last 30 days"
        />
        <StatCard
          label="Planting guide entries saved"
          value={headline ? formatNumber(headline.plantingGuideEntries) : EMPTY}
          sublabel="Last 30 days"
        />
      </div>

      {!error && (
        <>
          <h2 style={sectionHeading}>Feature usage</h2>
          <div style={tableBox}>
            <DataTable
              columns={featureColumns}
              rows={features}
              rowKey={(r) => r.key}
              sort={sort}
              onSortChange={(key, dir) => {
                if (!FEATURE_SORT_KEYS.includes(key as FeatureSortKey)) return;
                setSort({ key: key as FeatureSortKey, dir });
              }}
              emptyText="No feature usage recorded."
              loading={loading}
            />
          </div>

          <h2 style={sectionHeading}>Micro-feedback</h2>
          <div style={tableBox}>
            <DataTable
              columns={feedbackColumns}
              rows={report?.microFeedback ?? []}
              rowKey={(r) => r.triggerKey}
              emptyText="No micro-feedback prompts recorded."
              loading={loading}
            />
          </div>
        </>
      )}
    </div>
  );
}
