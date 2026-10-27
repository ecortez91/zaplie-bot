import React, { FunctionComponent, useEffect, useState } from 'react';
import styles from './RewardPolicyPanel.module.css';
import type {
  Person,
  RewardBudget,
  RewardPolicyPatch,
  RewardPolicyResponse,
} from '../apiService';
import type { BudgetSpend } from '../services/automationsStatsService';

// Only merged pull requests reach the bot today (the signed webhook), so the
// editor scopes levels and overrides to that event. Other events' stored
// overrides are kept untouched on save.
const EVENT = 'githubPrMerged' as const;
const EVENT_AMOUNT_KEY = 'githubPrMergedSats';

// Same patterns as backend/rewardPolicy.js; the server enforces them.
const LABEL_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{1,20}$/;
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_LEVELS = 10;

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

interface LevelDraft {
  name: string;
  bonus: string;
}

interface OverrideDraft {
  personAad: string;
  base: string;
}

interface BudgetDraft {
  period: 'week' | 'month';
  cap: string;
  timezone: string;
}

export interface RewardPolicyPanelProps {
  isAdmin: boolean;
  config: RewardPolicyResponse;
  spent?: BudgetSpend | null;
  loadPeople: () => Promise<Person[]>;
  // Resolves when saved; rejects with a message to show when refused.
  onSave: (patch: RewardPolicyPatch) => Promise<void>;
}

// A positive whole number of sats, or null. `Number('')` is 0 and
// `Number('1e3')` is 1000, so the digits are checked first.
export const parseSats = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const sats = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
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

const levelDrafts = (config: RewardPolicyResponse): LevelDraft[] =>
  Object.entries(config.rewardPolicy.levels[EVENT]?.bonuses ?? {}).map(
    ([name, bonus]) => ({ name, bonus: String(bonus) }),
  );

const overrideDrafts = (config: RewardPolicyResponse): OverrideDraft[] =>
  Object.entries(config.rewardPolicy.overrides)
    .filter(([, perEvent]) => perEvent[EVENT])
    .map(([personAad, perEvent]) => ({
      personAad,
      base: String(perEvent[EVENT]?.baseSats ?? ''),
    }));

const budgetDraft = (budget: RewardBudget | null): BudgetDraft => ({
  period: budget?.period ?? 'week',
  cap: budget ? String(budget.capSats) : '',
  timezone: budget?.timezone ?? 'Europe/London',
});

const RewardPolicyPanel: FunctionComponent<RewardPolicyPanelProps> = ({
  isAdmin,
  config,
  spent,
  loadPeople,
  onSave,
}) => {
  const policy = config.rewardPolicy;
  const cap = config.maxAmountSats;
  const orgBase = config.rewardAmounts[EVENT_AMOUNT_KEY];

  const [prefix, setPrefix] = useState(
    policy.levels[EVENT]?.labelPrefix ?? 'reward:',
  );
  const [levels, setLevels] = useState<LevelDraft[]>(() => levelDrafts(config));
  const [overrides, setOverrides] = useState<OverrideDraft[]>(() =>
    overrideDrafts(config),
  );
  const [budget, setBudget] = useState<BudgetDraft>(() =>
    budgetDraft(policy.budget),
  );
  const [people, setPeople] = useState<Person[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A saved policy comes back from the server: show exactly what it stored.
  useEffect(() => {
    setPrefix(config.rewardPolicy.levels[EVENT]?.labelPrefix ?? 'reward:');
    setLevels(levelDrafts(config));
    setOverrides(overrideDrafts(config));
    setBudget(budgetDraft(config.rewardPolicy.budget));
  }, [config]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }
    let cancelled = false;
    loadPeople()
      .then(list => {
        if (!cancelled) {
          setPeople(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPeople([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, loadPeople]);

  const nameFor = (personAad: string): string =>
    people.find(person => person.personAad === personAad)?.displayName ??
    personAad;

  const save = async (
    section: string,
    patch: RewardPolicyPatch | string,
  ): Promise<void> => {
    if (typeof patch === 'string') {
      setErrors(current => ({ ...current, [section]: patch }));
      return;
    }
    setErrors(current => ({ ...current, [section]: '' }));
    setSaving(section);
    try {
      await onSave(patch);
    } catch (error) {
      setErrors(current => ({
        ...current,
        [section]:
          error instanceof Error ? error.message : 'Could not save the change.',
      }));
    } finally {
      setSaving(null);
    }
  };

  // Every base this policy can pay for the event: the org base and each
  // person's override, each of which must leave room for the largest bonus.
  const largestBonus = (bonuses: number[]): number =>
    bonuses.length ? Math.max(...bonuses) : 0;

  const buildLevels = (): RewardPolicyPatch | string => {
    if (!LABEL_PREFIX_PATTERN.test(prefix)) {
      return "The label prefix must be 1-20 letters, digits, ':', '_' or '-'.";
    }
    if (levels.length > MAX_LEVELS) {
      return `At most ${MAX_LEVELS} levels.`;
    }
    const bonuses: Record<string, number> = {};
    for (const level of levels) {
      if (!LEVEL_NAME_PATTERN.test(level.name)) {
        return `Level "${level.name}" must be 1-20 letters, digits, '_' or '-'.`;
      }
      if (bonuses[level.name] !== undefined) {
        return `Level "${level.name}" is listed twice.`;
      }
      const sats = parseSats(level.bonus);
      if (sats === null) {
        return `The bonus for ${level.name} must be a positive whole number of sats.`;
      }
      bonuses[level.name] = sats;
    }
    const maxBonus = largestBonus(Object.values(bonuses));
    const bases = [
      ...(orgBase !== undefined ? [orgBase] : []),
      ...overrides
        .map(override => parseSats(override.base))
        .filter((base): base is number => base !== null),
    ];
    if (bases.some(base => base + maxBonus > cap) || maxBonus > cap) {
      return `A base plus the largest bonus (${NUMBER_FORMATTER.format(maxBonus)}) would exceed the per-reward cap of ${NUMBER_FORMATTER.format(cap)} sats.`;
    }
    const nextLevels = { ...policy.levels };
    if (levels.length === 0) {
      delete nextLevels[EVENT];
    } else {
      nextLevels[EVENT] = { labelPrefix: prefix, bonuses };
    }
    return { levels: nextLevels };
  };

  const buildOverrides = (): RewardPolicyPatch | string => {
    const maxBonus = largestBonus(
      Object.values(policy.levels[EVENT]?.bonuses ?? {}),
    );
    const seen = new Set<string>();
    // Keep every other event's overrides exactly as stored.
    const next: RewardPolicyPatch['overrides'] = {};
    for (const [personAad, perEvent] of Object.entries(policy.overrides)) {
      const { [EVENT]: _dropped, ...others } = perEvent;
      if (Object.keys(others).length > 0) {
        next[personAad] = others;
      }
    }
    for (const override of overrides) {
      if (!override.personAad) {
        return 'Choose a person for every override.';
      }
      if (seen.has(override.personAad)) {
        return `${nameFor(override.personAad)} has two overrides.`;
      }
      seen.add(override.personAad);
      const base = parseSats(override.base);
      if (base === null) {
        return `The base for ${nameFor(override.personAad)} must be a positive whole number of sats.`;
      }
      if (base + maxBonus > cap) {
        return `${nameFor(override.personAad)}: ${NUMBER_FORMATTER.format(base)} plus the largest bonus would exceed the per-reward cap of ${NUMBER_FORMATTER.format(cap)} sats.`;
      }
      next[override.personAad] = {
        ...(next[override.personAad] ?? {}),
        [EVENT]: { baseSats: base },
      };
    }
    return { overrides: next };
  };

  const buildBudget = (): RewardPolicyPatch | string => {
    const capSats = parseSats(budget.cap);
    if (capSats === null) {
      return 'The budget must be a positive whole number of sats.';
    }
    if (!isValidTimezone(budget.timezone)) {
      return 'Enter an IANA time zone, like Europe/London.';
    }
    return {
      budget: {
        period: budget.period,
        capSats,
        timezone: budget.timezone.trim(),
      },
    };
  };

  const errorFor = (section: string) =>
    errors[section] ? (
      <p className={styles.error} role="alert">
        {errors[section]}
      </p>
    ) : null;

  const usedOverrides = new Set(overrides.map(override => override.personAad));

  return (
    <section className={styles.panel} aria-label="Reward policy">
      <article className={styles.card}>
        <header className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Budget</h4>
          <span className={styles.hint}>
            Nothing pays until a budget is set.
          </span>
        </header>
        {spent ? (
          <p className={styles.spent} data-testid="budget-spent">
            {NUMBER_FORMATTER.format(spent.spentSats)} of{' '}
            {NUMBER_FORMATTER.format(spent.capSats)} sats paid this{' '}
            {spent.period}
          </p>
        ) : null}
        {isAdmin ? (
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Period</span>
              <select
                value={budget.period}
                onChange={e =>
                  setBudget({
                    ...budget,
                    period: e.target.value === 'month' ? 'month' : 'week',
                  })
                }
              >
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Cap (sats)</span>
              <input
                aria-label="Budget cap in sats"
                inputMode="numeric"
                value={budget.cap}
                placeholder="Not set"
                onChange={e => setBudget({ ...budget, cap: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>Time zone</span>
              <input
                aria-label="Budget time zone"
                value={budget.timezone}
                onChange={e =>
                  setBudget({ ...budget, timezone: e.target.value })
                }
              />
            </label>
            <button
              className={styles.save}
              disabled={saving !== null}
              onClick={() => save('budget', buildBudget())}
            >
              {saving === 'budget' ? 'Saving...' : 'Save budget'}
            </button>
          </div>
        ) : (
          <p className={styles.value}>
            {policy.budget
              ? `${NUMBER_FORMATTER.format(policy.budget.capSats)} sats per ${policy.budget.period} (${policy.budget.timezone})`
              : 'Not set: no reward pays until an admin sets a budget.'}
          </p>
        )}
        {errorFor('budget')}
      </article>

      <article className={styles.card}>
        <header className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Level bonuses</h4>
          <span className={styles.hint}>
            Added to the base when the merged pull request carries the label{' '}
            <code>
              {prefix}
              {'<level>'}
            </code>
            . Only the highest level counts.
          </span>
        </header>
        {isAdmin ? (
          <>
            <label className={styles.field}>
              <span>Label prefix</span>
              <input
                aria-label="Label prefix"
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
              />
            </label>
            {levels.map((level, index) => (
              <div className={styles.row} key={index}>
                <label className={styles.field}>
                  <span>Level</span>
                  <input
                    aria-label={`Level ${index + 1} name`}
                    value={level.name}
                    onChange={e =>
                      setLevels(
                        levels.map((item, i) =>
                          i === index
                            ? { ...item, name: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label className={styles.field}>
                  <span>Bonus (sats)</span>
                  <input
                    aria-label={`Level ${index + 1} bonus`}
                    inputMode="numeric"
                    value={level.bonus}
                    onChange={e =>
                      setLevels(
                        levels.map((item, i) =>
                          i === index
                            ? { ...item, bonus: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  className={styles.remove}
                  onClick={() =>
                    setLevels(levels.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                className={styles.add}
                disabled={levels.length >= MAX_LEVELS}
                onClick={() =>
                  setLevels([
                    ...levels,
                    { name: `L${levels.length + 1}`, bonus: '' },
                  ])
                }
              >
                Add level
              </button>
              <button
                className={styles.save}
                disabled={saving !== null}
                onClick={() => save('levels', buildLevels())}
              >
                {saving === 'levels' ? 'Saving...' : 'Save levels'}
              </button>
            </div>
          </>
        ) : levels.length === 0 ? (
          <p className={styles.value}>No level bonuses.</p>
        ) : (
          <ul className={styles.list}>
            {levels.map(level => (
              <li key={level.name}>
                <code>
                  {prefix}
                  {level.name}
                </code>
                : +{NUMBER_FORMATTER.format(Number(level.bonus))} sats
              </li>
            ))}
          </ul>
        )}
        {errorFor('levels')}
      </article>

      <article className={styles.card}>
        <header className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Per-person base</h4>
          <span className={styles.hint}>
            Replaces the pull-request amount for one person. Everyone else gets{' '}
            {orgBase !== undefined
              ? `${NUMBER_FORMATTER.format(orgBase)} sats`
              : 'nothing until the amount is set'}
            .
          </span>
        </header>
        {isAdmin ? (
          <>
            {overrides.map((override, index) => (
              <div className={styles.row} key={index}>
                <label className={styles.field}>
                  <span>Person</span>
                  <select
                    aria-label={`Override ${index + 1} person`}
                    value={override.personAad}
                    onChange={e =>
                      setOverrides(
                        overrides.map((item, i) =>
                          i === index
                            ? { ...item, personAad: e.target.value }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a person</option>
                    {override.personAad &&
                    !people.some(p => p.personAad === override.personAad) ? (
                      <option value={override.personAad}>
                        {override.personAad}
                      </option>
                    ) : null}
                    {people
                      .filter(
                        person =>
                          person.personAad === override.personAad ||
                          !usedOverrides.has(person.personAad),
                      )
                      .map(person => (
                        <option key={person.personAad} value={person.personAad}>
                          {person.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Base (sats)</span>
                  <input
                    aria-label={`Override ${index + 1} base`}
                    inputMode="numeric"
                    value={override.base}
                    onChange={e =>
                      setOverrides(
                        overrides.map((item, i) =>
                          i === index
                            ? { ...item, base: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  className={styles.remove}
                  onClick={() =>
                    setOverrides(overrides.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                className={styles.add}
                onClick={() =>
                  setOverrides([...overrides, { personAad: '', base: '' }])
                }
              >
                Add person
              </button>
              <button
                className={styles.save}
                disabled={saving !== null}
                onClick={() => save('overrides', buildOverrides())}
              >
                {saving === 'overrides' ? 'Saving...' : 'Save overrides'}
              </button>
            </div>
          </>
        ) : overrides.length === 0 ? (
          <p className={styles.value}>No per-person amounts.</p>
        ) : (
          <p className={styles.value}>
            {overrides.length} per-person{' '}
            {overrides.length === 1 ? 'amount' : 'amounts'} set by an admin.
          </p>
        )}
        {errorFor('overrides')}
      </article>
    </section>
  );
};

export default RewardPolicyPanel;
