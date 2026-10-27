// The allowance sync's cache and audit trail, in the portal data directory.
//
// allowance-sync.json is a cache, not the truth: LNbits and the allowance
// extension are, and every run rebuilds from them. It remembers what Zaplie
// last wrote to each person's schedule (to tell a policy change from a hand
// edit) and the last 50 run summaries. allowance-audit.jsonl gets one line per
// change. Neither ever holds a key.
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataPaths');
const { ensureSecureDir, writeJsonSecure } = require('./secureJsonStore');

const STATE_FILE = 'allowance-sync.json';
const AUDIT_FILE = 'allowance-audit.jsonl';
const MAX_RUNS = 50;

const emptyState = () => ({ version: 1, lastRun: null, runs: [], byPerson: {} });

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createAllowanceSyncStore = ({
  statePath = dataPath(STATE_FILE),
  auditPath = dataPath(AUDIT_FILE),
} = {}) => {
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.byPerson)) {
      throw new Error(`${STATE_FILE} is malformed`);
    }
    return {
      ...emptyState(),
      ...parsed,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  };

  const write = (state) => {
    writeJsonSecure(statePath, {
      ...state,
      runs: (state.runs || []).slice(-MAX_RUNS),
    });
  };

  const appendAudit = (entries) => {
    if (!entries || entries.length === 0) return;
    ensureSecureDir(path.dirname(auditPath));
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    fs.appendFileSync(auditPath, lines, { mode: 0o600 });
  };

  return { read, write, appendAudit, statePath, auditPath };
};

module.exports = { AUDIT_FILE, MAX_RUNS, STATE_FILE, createAllowanceSyncStore, emptyState };
