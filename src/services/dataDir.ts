// Single resolution rule for ZAPLIE_DATA_DIR, the directory holding the bot's
// mutable on-disk state.
//
// Every deployed runtime must point it at an absolute, persistent path outside
// the deployment artifact: state written into `wwwroot` is destroyed by the
// next clean deploy. Only an explicit `NODE_ENV=development` run that is not on
// Azure may fall back to the git-ignored `.zaplie-data` directory, so a
// forgotten setting fails at startup instead of silently losing money records.

import * as path from 'path';

export class DataDirError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DataDirError';
  }
}

export const DEVELOPMENT_DATA_DIR = '.zaplie-data';

// App Service passes app settings to the process verbatim - it does not expand
// %VAR% for an arbitrary setting - so the one token worth supporting is
// expanded here instead of being hard-coded per stamp. The persistent share is
// %HOME% on every App Service: D:\home on the older Windows stamps, C:\home on
// newer ones, /home on Linux. Hard-coding a drive letter is what breaks when an
// app moves stamp.
const HOME_TOKEN = /^%HOME%/i;
const FALLBACK_HOME = process.platform === 'win32' ? 'D:\\home' : '/home';

const expandHome = (value: string, environment: NodeJS.ProcessEnv): string => {
  if (!HOME_TOKEN.test(value)) {
    return value;
  }
  const home = environment.HOME?.trim() || FALLBACK_HOME;
  const rest = value
    .replace(HOME_TOKEN, '')
    .split(/[\\/]+/)
    .filter(segment => segment.length > 0);
  // Rejoined with this platform's separator, so the same setting is correct on
  // a Windows stamp and a Linux one.
  return path.join(home, ...rest);
};

const isAzureRuntime = (environment: NodeJS.ProcessEnv): boolean =>
  Boolean(
    environment.RUNNING_ON_AZURE ||
    environment.WEBSITE_INSTANCE_ID ||
    environment.WEBSITE_SITE_NAME,
  );

export const resolveDataDir = (
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string => {
  const raw = environment.ZAPLIE_DATA_DIR?.trim();
  const configured = raw ? expandHome(raw, environment) : raw;
  const durableRuntime =
    environment.NODE_ENV !== 'development' || isAzureRuntime(environment);

  if (configured) {
    if (durableRuntime && !path.isAbsolute(configured)) {
      throw new DataDirError(
        'ZAPLIE_DATA_DIR must be an absolute durable path in production',
      );
    }
    return path.resolve(workingDirectory, configured);
  }

  if (durableRuntime) {
    throw new DataDirError(
      'ZAPLIE_DATA_DIR is required outside explicit development mode',
    );
  }

  return path.resolve(workingDirectory, DEVELOPMENT_DATA_DIR);
};
