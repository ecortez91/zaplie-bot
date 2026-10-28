import React, { FunctionComponent, useEffect, useState } from 'react';
import styles from './RewardPolicyPanel.module.css';
import own from './AllowancePanel.module.css';
import type {
  AllowancePeriod,
  AllowancePolicy,
  AllowancePolicyPatch,
  AllowanceStatus,
  AllowanceSyncResult,
} from '../apiService';

// Same rules as backend/allowancePolicy.js; the server enforces them.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HIDDEN_MEMO_PATTERN = /weekly allowance cleared/i;
const MAX_MEMO_LENGTH = 200;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MAX_TABLE_ROWS = 200;
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

export interface PolicyDraft {
  enabled: boolean;
  amount: string;
  period: AllowancePeriod;
  anchorWeekday: string;
  anchorDay: string;
  anchorTime: string;
  timezone: string;
  memo: string;
  minSats: string;
  maxSats: string;
  commentChars: string;
}

export interface AllowancePanelProps {
  isAdmin: boolean;
  status: AllowanceStatus;
  // Each resolves with the server's answer, or rejects with a message to show.
  onSave: (patch: AllowancePolicyPatch) => Promise<void>;
  onPreview: (options: {
    overwriteDrift: boolean;
  }) => Promise<AllowanceSyncResult>;
  onApply: (options: {
    confirmTotalSats: number;
    overwriteDrift: boolean;
    allowUnderfunded: boolean;
    allowMassDelete: boolean;
  }) => Promise<AllowanceSyncResult>;
}

const parseWhole = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const number = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(number) ? number : null;
};

const isValidTimezone = (timezone: string): boolean => {
  if (!timezone.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
};

const draftFrom = (policy: AllowancePolicy): PolicyDraft => ({
  enabled: policy.enabled,
  amount: policy.amountSats === null ? '' : String(policy.amountSats),
  period: policy.period ?? 'weekly',
  anchorWeekday:
    policy.anchorWeekday === null ? '' : String(policy.anchorWeekday),
  anchorDay: policy.anchorDay === null ? '' : String(policy.anchorDay),
  anchorTime: policy.anchorTime ?? '',
  timezone: policy.timezone ?? '',
  memo: policy.memo,
  minSats:
    policy.payLink.minSats === null ? '' : String(policy.payLink.minSats),
  maxSats:
    policy.payLink.maxSats === null ? '' : String(policy.payLink.maxSats),
  commentChars: String(policy.payLink.commentChars),
});

/** The patch to send, or a message saying what to fix. */
export const buildAllowancePatch = (
  draft: PolicyDraft,
  maxAmountSats: number,
): AllowancePolicyPatch | string => {
  const amount = draft.amount.trim() === '' ? null : parseWhole(draft.amount);
  if (draft.amount.trim() !== '' && (amount === null || amount <= 0)) {
    return 'The amount must be a positive whole number of sats.';
  }
  if (amount !== null && amount > maxAmountSats) {
    return `The amount cannot exceed ${NUMBER_FORMATTER.format(maxAmountSats)} sats (ALLOWANCE_MAX_AMOUNT_SATS).`;
  }
  const weekday =
    draft.anchorWeekday === '' ? null : parseWhole(draft.anchorWeekday);
  const day =
    draft.anchorDay.trim() === '' ? null : parseWhole(draft.anchorDay);
  if (day !== null && (day < 1 || day > 28)) {
    return 'The day of the month must be 1 to 28.';
  }
  if (draft.anchorDay.trim() !== '' && day === null) {
    return 'The day of the month must be 1 to 28.';
  }
  const time = draft.anchorTime.trim();
  if (time && !TIME_PATTERN.test(time)) {
    return 'The time must be HH:mm, 24-hour.';
  }
  const timezone = draft.timezone.trim();
  if (timezone && !isValidTimezone(timezone)) {
    return 'Enter an IANA time zone, like Europe/London.';
  }
  if (draft.memo.length > MAX_MEMO_LENGTH) {
    return `The memo must be at most ${MAX_MEMO_LENGTH} characters.`;
  }
  if (HIDDEN_MEMO_PATTERN.test(draft.memo)) {
    return 'The memo must not contain "Weekly Allowance cleared": those payments are hidden from every report.';
  }
  const minSats =
    draft.minSats.trim() === '' ? null : parseWhole(draft.minSats);
  const maxSats =
    draft.maxSats.trim() === '' ? null : parseWhole(draft.maxSats);
  if ((draft.minSats.trim() !== '') !== (draft.maxSats.trim() !== '')) {
    return 'Set both the pay link minimum and maximum, or neither.';
  }
  if (
    (draft.minSats.trim() !== '' && (minSats === null || minSats <= 0)) ||
    (draft.maxSats.trim() !== '' && (maxSats === null || maxSats <= 0))
  ) {
    return 'The pay link range must be positive whole numbers of sats.';
  }
  const commentChars = parseWhole(draft.commentChars || '0');
  if (commentChars === null || commentChars > 799) {
    return 'Comment characters must be 0 to 799.';
  }
  if (draft.enabled) {
    const missing: string[] = [];
    if (amount === null) missing.push('the amount');
    if (draft.period === 'weekly' && weekday === null)
      missing.push('the weekday');
    if (draft.period === 'monthly' && day === null)
      missing.push('the day of the month');
    if (!time) missing.push('the time');
    if (!timezone) missing.push('the time zone');
    if (missing.length > 0) {
      return `To turn allowances on, set ${missing.join(', ')}.`;
    }
    if (
      minSats !== null &&
      maxSats !== null &&
      amount !== null &&
      (amount < minSats || amount > maxSats)
    ) {
      return 'The pay link range must include the amount.';
    }
  }
  return {
    enabled: draft.enabled,
    amountSats: amount,
    period: draft.period,
    anchorWeekday: draft.period === 'weekly' ? weekday : null,
    anchorDay: draft.period === 'monthly' ? day : null,
    anchorTime: time || null,
    timezone: timezone || null,
    memo: draft.memo.trim(),
    payLink: { minSats, maxSats, commentChars },
  };
};

const scheduleText = (policy: AllowancePolicy): string => {
  if (policy.amountSats === null || !policy.period || !policy.anchorTime) {
    return 'Not set.';
  }
  const when =
    policy.period === 'weekly'
      ? `every ${WEEKDAYS[policy.anchorWeekday ?? 0]}`
      : `on day ${policy.anchorDay} of each month`;
  return `${NUMBER_FORMATTER.format(policy.amountSats)} sats ${when} at ${policy.anchorTime} (${policy.timezone})`;
};

const actionDetail = (action: AllowanceSyncResult['actions'][number]) =>
  [
    action.reason,
    action.fields?.length ? `changes ${action.fields.join(', ')}` : null,
    action.amountSats
      ? `${NUMBER_FORMATTER.format(action.amountSats)} sats`
      : null,
    action.lightningAddress,
    action.error,
  ]
    .filter(Boolean)
    .join(' · ');

const AllowancePanel: FunctionComponent<AllowancePanelProps> = ({
  isAdmin,
  status,
  onSave,
  onPreview,
  onApply,
}) => {
  const { policy, fund } = status;
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(policy));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [overwriteDrift, setOverwriteDrift] = useState(false);
  const [allowUnderfunded, setAllowUnderfunded] = useState(false);
  const [allowMassDelete, setAllowMassDelete] = useState(false);
  const [preview, setPreview] = useState<AllowanceSyncResult | null>(null);
  const [applied, setApplied] = useState<AllowanceSyncResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A saved policy comes back from the server: show exactly what it stored,
  // and drop any preview made against the previous one.
  useEffect(() => {
    setDraft(draftFrom(status.policy));
    setPreview(null);
  }, [status.policy]);

  const setError = (section: string, message: string) =>
    setErrors(current => ({ ...current, [section]: message }));

  const errorFor = (section: string) =>
    errors[section] ? (
      <p className={styles.error} role="alert">
        {errors[section]}
      </p>
    ) : null;

  const messageOf = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  const save = async () => {
    const patch = buildAllowancePatch(draft, status.maxAmountSats);
    if (typeof patch === 'string') {
      setError('policy', patch);
      return;
    }
    setError('policy', '');
    setSaving(true);
    try {
      await onSave(patch);
    } catch (error) {
      setError('policy', messageOf(error, 'Could not save the policy.'));
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setError('sync', '');
    setBusy('preview');
    setApplied(null);
    setAllowUnderfunded(false);
    setAllowMassDelete(false);
    try {
      setPreview(await onPreview({ overwriteDrift }));
    } catch (error) {
      setPreview(null);
      setError('sync', messageOf(error, 'Could not preview the sync.'));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    if (!preview) {
      return;
    }
    setError('sync', '');
    setBusy('apply');
    try {
      const result = await onApply({
        confirmTotalSats: preview.summary.totalPerPeriodSats,
        overwriteDrift,
        allowUnderfunded,
        allowMassDelete,
      });
      setApplied(result);
    } catch (error) {
      setError('sync', messageOf(error, 'Could not apply the sync.'));
    } finally {
      // Applied or refused, the preview is spent: the next apply needs a
      // fresh one.
      setPreview(null);
      setBusy(null);
    }
  };

  // Many leavers at once usually means a short LNbits list, not a real
  // exodus: the admin confirms it with its own tick, as for underfunded.
  const massDelete = (preview?.blockers ?? []).some(
    blocker => blocker.code === 'mass-delete',
  );
  const hardBlockers = (preview?.blockers ?? []).filter(
    blocker => !blocker.overridable && blocker.code !== 'mass-delete',
  );
  const underfunded = (preview?.blockers ?? []).some(
    blocker => blocker.overridable,
  );
  const canApply =
    preview !== null &&
    preview.summary.changes > 0 &&
    hardBlockers.length === 0 &&
    (!underfunded || allowUnderfunded) &&
    (!massDelete || allowMassDelete) &&
    busy === null;

  const health = fund.health;
  const healthLabel = !health
    ? 'Unknown'
    : health.healthy
      ? 'Healthy'
      : 'Needs attention';
  const lastRun = status.lastRun;

  return (
    <section className={styles.panel} aria-label="Weekly allowances">
      <article className={styles.card}>
        <header className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Allowance policy</h4>
          <span className={styles.hint}>
            Nothing is created or paid until an admin turns this on with an
            amount and a schedule. The LNbits allowance extension pays from the
            Fund wallet; Zaplie only keeps the schedules.
          </span>
        </header>
        {isAdmin ? (
          <>
            <label className={own.toggle}>
              <input
                type="checkbox"
                data-testid="allowance-enabled"
                checked={draft.enabled}
                onChange={e =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              <span>
                Allowances {draft.enabled ? 'on' : 'off (schedules are paused)'}
              </span>
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Amount (sats)</span>
                <input
                  data-testid="allowance-amount"
                  inputMode="numeric"
                  placeholder="e.g. 25000"
                  value={draft.amount}
                  onChange={e => setDraft({ ...draft, amount: e.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>Period</span>
                <select
                  data-testid="allowance-period"
                  value={draft.period}
                  onChange={e =>
                    setDraft({
                      ...draft,
                      period:
                        e.target.value === 'monthly' ? 'monthly' : 'weekly',
                    })
                  }
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {draft.period === 'weekly' ? (
                <label className={styles.field}>
                  <span>Day</span>
                  <select
                    data-testid="allowance-weekday"
                    value={draft.anchorWeekday}
                    onChange={e =>
                      setDraft({ ...draft, anchorWeekday: e.target.value })
                    }
                  >
                    <option value="">Choose a day</option>
                    {WEEKDAYS.map((name, index) => (
                      <option key={name} value={String(index)}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className={styles.field}>
                  <span>Day of month</span>
                  <input
                    data-testid="allowance-day-of-month"
                    inputMode="numeric"
                    placeholder="1-28"
                    value={draft.anchorDay}
                    onChange={e =>
                      setDraft({ ...draft, anchorDay: e.target.value })
                    }
                  />
                </label>
              )}
            </div>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Time (HH:mm)</span>
                <input
                  data-testid="allowance-time"
                  placeholder="e.g. 09:00"
                  value={draft.anchorTime}
                  onChange={e =>
                    setDraft({ ...draft, anchorTime: e.target.value })
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Time zone</span>
                <input
                  data-testid="allowance-timezone"
                  placeholder="e.g. Europe/London"
                  value={draft.timezone}
                  onChange={e =>
                    setDraft({ ...draft, timezone: e.target.value })
                  }
                />
              </label>
            </div>
            <label className={styles.field}>
              <span>Memo</span>
              <input
                data-testid="allowance-memo"
                value={draft.memo}
                onChange={e => setDraft({ ...draft, memo: e.target.value })}
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Pay link min (sats)</span>
                <input
                  data-testid="allowance-min"
                  inputMode="numeric"
                  placeholder="the amount"
                  value={draft.minSats}
                  onChange={e =>
                    setDraft({ ...draft, minSats: e.target.value })
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Pay link max (sats)</span>
                <input
                  data-testid="allowance-max"
                  inputMode="numeric"
                  placeholder="the amount"
                  value={draft.maxSats}
                  onChange={e =>
                    setDraft({ ...draft, maxSats: e.target.value })
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Comment characters</span>
                <input
                  data-testid="allowance-comment-chars"
                  inputMode="numeric"
                  value={draft.commentChars}
                  onChange={e =>
                    setDraft({ ...draft, commentChars: e.target.value })
                  }
                />
              </label>
            </div>
            <div className={styles.actions}>
              <button
                className={styles.save}
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving...' : 'Save policy'}
              </button>
            </div>
          </>
        ) : (
          <p className={styles.value} data-testid="allowance-policy">
            {policy.enabled
              ? scheduleText(policy)
              : 'Off: no allowance is created or paid.'}
          </p>
        )}
        {errorFor('policy')}
      </article>

      <article className={styles.card}>
        <header className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Fund and health</h4>
          <span className={styles.hint}>
            The extension pays every allowance from the Fund wallet.
          </span>
        </header>
        {!fund.configured ? (
          <p className={styles.value}>
            Fund wallet not configured: previews show pay links only and nothing
            can be applied.
          </p>
        ) : fund.error ? (
          <p className={styles.value}>{fund.error}</p>
        ) : (
          <ul className={styles.list}>
            {fund.wallets.map(wallet => (
              <li key={wallet.id ?? wallet.name}>
                {wallet.name}:{' '}
                {wallet.balanceSats === null
                  ? 'balance unavailable'
                  : `${NUMBER_FORMATTER.format(wallet.balanceSats)} sats`}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.value}>
          Extension:{' '}
          <span
            className={
              health?.healthy ? own.badgeOk : health ? own.badgeWarn : own.badge
            }
            data-testid="allowance-health"
          >
            {healthLabel}
          </span>
          {health && !health.healthy
            ? ` (overdue ${health.overdue ?? '?'}, pending ${health.pending ?? '?'})`
            : null}
        </p>
        <p className={styles.hint}>
          {status.timer.enabled
            ? `Automatic sync every ${status.timer.intervalMinutes} minutes, once an admin has applied the current policy.`
            : 'Automatic sync is off.'}
        </p>
        {lastRun ? (
          <p className={styles.hint} data-testid="allowance-last-run">
            Last {lastRun.mode === 'apply' ? 'apply' : 'run'}{' '}
            {new Date(lastRun.at).toLocaleString()} by {lastRun.by}: created{' '}
            {lastRun.created}, updated {lastRun.updated}, deleted{' '}
            {lastRun.deleted}, errors {lastRun.errors}
            {lastRun.aborted ? ' (stopped)' : ''}.
          </p>
        ) : (
          <p className={styles.hint}>No sync has run yet.</p>
        )}
      </article>

      {isAdmin ? (
        <article className={`${styles.card} ${own.wide}`}>
          <header className={styles.cardHeader}>
            <h4 className={styles.cardTitle}>Sync</h4>
            <span className={styles.hint}>
              Preview first: nothing changes until you apply the previewed plan.
            </span>
          </header>
          <label className={own.toggle}>
            <input
              type="checkbox"
              data-testid="sync-overwrite-drift"
              checked={overwriteDrift}
              onChange={e => {
                setOverwriteDrift(e.target.checked);
                setPreview(null);
              }}
            />
            <span>Overwrite schedules edited by hand</span>
          </label>
          <div className={styles.actions}>
            <button
              className={styles.add}
              disabled={busy !== null}
              onClick={() => void runPreview()}
            >
              {busy === 'preview' ? 'Previewing...' : 'Preview sync'}
            </button>
            {preview ? (
              <button
                className={styles.save}
                disabled={!canApply}
                onClick={() => void runApply()}
              >
                {busy === 'apply'
                  ? 'Applying...'
                  : `Apply ${preview.summary.changes} changes`}
              </button>
            ) : null}
          </div>
          {preview ? (
            <div data-testid="allowance-preview">
              <p className={styles.value}>
                {preview.summary.people} people · total per period{' '}
                <strong>
                  {NUMBER_FORMATTER.format(preview.summary.totalPerPeriodSats)}{' '}
                  sats
                </strong>{' '}
                · Fund holds{' '}
                {NUMBER_FORMATTER.format(preview.summary.fundBalanceSats)} sats
              </p>
              <p className={styles.hint}>
                Pay links +{preview.summary.paylinkCreates} ~
                {preview.summary.paylinkUpdates}; schedules +
                {preview.summary.creates} ~{preview.summary.updates} recreated{' '}
                {preview.summary.recreates} −{preview.summary.deletes}; noop{' '}
                {preview.summary.noop}, drift {preview.summary.drift}, paused{' '}
                {preview.summary.paused}, deferred {preview.summary.deferred},
                skipped {preview.summary.skipped}
              </p>
              {preview.warnings.map(warning => (
                <p key={warning.code} className={own.warning}>
                  {warning.message}
                </p>
              ))}
              {preview.blockers.map(blocker => (
                <p key={blocker.code} className={styles.error} role="alert">
                  {blocker.message}
                </p>
              ))}
              {underfunded ? (
                <label className={own.toggle}>
                  <input
                    type="checkbox"
                    data-testid="sync-allow-underfunded"
                    checked={allowUnderfunded}
                    onChange={e => setAllowUnderfunded(e.target.checked)}
                  />
                  <span>
                    Apply although the Fund holds less than one period
                  </span>
                </label>
              ) : null}
              {massDelete ? (
                <label className={own.toggle}>
                  <input
                    type="checkbox"
                    data-testid="sync-allow-mass-delete"
                    checked={allowMassDelete}
                    onChange={e => setAllowMassDelete(e.target.checked)}
                  />
                  <span>
                    These people have left LNbits: delete their schedules
                  </span>
                </label>
              ) : null}
              <table className={own.table}>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Person</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.actions
                    .filter(action => action.kind !== 'noop')
                    .slice(0, MAX_TABLE_ROWS)
                    .map((action, index) => (
                      <tr
                        key={`${action.kind}-${action.oid ?? index}-${index}`}
                      >
                        <td>{action.kind}</td>
                        <td>{action.displayName ?? action.oid ?? '—'}</td>
                        <td>{actionDetail(action)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {applied?.result ? (
            <p className={styles.spent} data-testid="allowance-applied">
              Applied: created {applied.result.created}, updated{' '}
              {applied.result.updated}, deleted {applied.result.deleted}, pay
              links {applied.result.payLinks}, drift {applied.result.drift},
              errors {applied.result.errors}
              {applied.result.aborted ? ' (stopped early)' : ''}.
            </p>
          ) : null}
          {errorFor('sync')}
        </article>
      ) : null}
    </section>
  );
};

export default AllowancePanel;
