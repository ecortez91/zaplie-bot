import * as path from 'path';
import { DataDirError, resolveDataDir } from './dataDir';

const workingDirectory = path.resolve('working-directory');
const durableDirectory = path.resolve(path.sep, 'srv', 'zaplie-data');

describe('resolveDataDir', () => {
  test('requires an absolute directory in every deployed runtime', () => {
    expect(() =>
      resolveDataDir({ NODE_ENV: 'production' }, workingDirectory),
    ).toThrow(DataDirError);
    expect(() =>
      resolveDataDir(
        { WEBSITE_INSTANCE_ID: 'azure-instance' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(() =>
      resolveDataDir(
        { NODE_ENV: 'production', ZAPLIE_DATA_DIR: 'relative-data' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR must be an absolute durable path');
    // Explicit development mode still counts as deployed when it runs on Azure.
    expect(() =>
      resolveDataDir(
        { NODE_ENV: 'development', WEBSITE_SITE_NAME: 'azure-site' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(
      resolveDataDir(
        { NODE_ENV: 'production', ZAPLIE_DATA_DIR: durableDirectory },
        workingDirectory,
      ),
    ).toBe(durableDirectory);
  });

  test('%HOME% is expanded for the platform instead of hard-coding a stamp', () => {
    // App Service passes the setting through verbatim, so the bot expands it.
    expect(
      resolveDataDir(
        {
          NODE_ENV: 'production',
          ZAPLIE_DATA_DIR: '%HOME%\\data\\zaplie',
          HOME: path.resolve(path.sep, 'srv', 'home'),
        },
        workingDirectory,
      ),
    ).toBe(path.resolve(path.sep, 'srv', 'home', 'data', 'zaplie'));
    // A forward-slash spelling of the same setting resolves identically.
    expect(
      resolveDataDir(
        {
          NODE_ENV: 'production',
          ZAPLIE_DATA_DIR: '%HOME%/data/zaplie',
          HOME: path.resolve(path.sep, 'srv', 'home'),
        },
        workingDirectory,
      ),
    ).toBe(path.resolve(path.sep, 'srv', 'home', 'data', 'zaplie'));
    // Without HOME the platform default stands in, and the result is still
    // absolute rather than landing beside the deployment artifact.
    const withoutHome = resolveDataDir(
      { NODE_ENV: 'production', ZAPLIE_DATA_DIR: '%HOME%/data/zaplie' },
      workingDirectory,
    );
    expect(path.isAbsolute(withoutHome)).toBe(true);
    expect(withoutHome).not.toContain('%HOME%');
    expect(withoutHome.startsWith(workingDirectory)).toBe(false);
  });

  test('only explicit development mode receives the ignored local fallback', () => {
    expect(resolveDataDir({ NODE_ENV: 'development' }, workingDirectory)).toBe(
      path.join(workingDirectory, '.zaplie-data'),
    );
    expect(() => resolveDataDir({}, workingDirectory)).toThrow(DataDirError);
  });
});
