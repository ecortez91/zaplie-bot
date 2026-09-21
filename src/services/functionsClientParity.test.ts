// The Azure Functions package builds on its own and cannot share code with
// the bot, so the pieces that must stay in step are pinned from here: the
// payment-metadata role union, and the rule that no credential and no
// user or wallet object reaches a log line of the Functions package.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, test } from '@jest/globals';

const root = path.resolve(__dirname, '../..');
const read = (relative: string): string =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const roleUnion = (source: string): string[] => {
  const match = source.match(/export type PaymentExtraRole =([^;]*);/);
  if (!match) {
    throw new Error('PaymentExtraRole not found');
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g), m => m[1]).sort();
};

// Every .ts source of the Functions package (not its build or dependencies).
const functionSources = (directory = 'functions'): string[] =>
  fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap(entry => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return ['node_modules', 'dist'].includes(entry.name)
          ? []
          : functionSources(relative);
      }
      return entry.name.endsWith('.ts') ? [relative] : [];
    });

// The argument text of every live console.log / context.log call, found by
// balancing parentheses so multi-line templates are covered. Whole-line and
// block comments are dropped first: commented-out code is not a log line.
const logCalls = (source: string): string[] => {
  const calls: string[] = [];
  const live = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const opener = /\b(?:console|context)\.log\(/g;
  for (const match of live.matchAll(opener)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < live.length && depth > 0) {
      const char = live[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    calls.push(live.slice(start, index - 1));
  }
  return calls;
};

// A credential interpolated into the line, or a whole object that carries
// one (request body or query, a user, a wallet, an API response) passed as
// an argument by itself.
const CREDENTIAL_INTERPOLATION = /\$\{[^}]*(key|token|password|secret)[^}]*\}/i;
// A wallet object by name (privateWallet, matchingWallet, wallets), not an id
// such as receiverWalletId.
const OBJECT_DUMP =
  /^(?:req\.(?:body|query)|users?|sender|receiver|data|responseData|walletData|(?:\w*[wW]allet)s?)$/;

const offendingLogLines = (relative: string): string[] =>
  logCalls(read(relative)).filter(call => {
    if (CREDENTIAL_INTERPOLATION.test(call)) return true;
    // Top-level arguments, split on commas outside quotes and braces.
    const args: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let current = '';
    for (const char of call) {
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth -= 1;
      else if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    args.push(current.trim());
    return args.some(argument => OBJECT_DUMP.test(argument));
  });

describe('functions/ mirrors of src/', () => {
  test('the PaymentExtraRole unions are identical', () => {
    expect(roleUnion(read('functions/services/paymentExtra.ts'))).toEqual(
      roleUnion(read('src/services/paymentExtra.ts')),
    );
  });

  test('no credential and no user or wallet object reaches a log line of the functions package', () => {
    const sources = functionSources();
    expect(sources.length).toBeGreaterThan(3);
    const offending = Object.fromEntries(
      sources
        .map(relative => [relative, offendingLogLines(relative)] as const)
        .filter(([, lines]) => lines.length > 0),
    );
    expect(offending).toEqual({});
  });
});
