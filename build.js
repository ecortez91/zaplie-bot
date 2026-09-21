const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
  substitutePlaceholders,
  findUnresolvedPlaceholders,
} = require('./scripts/manifestTemplate');

// manifest.template.json carries two placeholder forms:
//   {{NAME}}   resolved below, by this script
//   ${{NAME}}  left for Teams Toolkit to resolve from env/.env.<env>

const envDir = path.join(__dirname, 'env');

const readEnvFile = filePath =>
  fs.existsSync(filePath) ? dotenv.parse(fs.readFileSync(filePath)) : {};

// Load optional development defaults, then overlay the active Teams
// environment. Process variables win so CI can build without local .env files.
let envConfig = readEnvFile(path.join(envDir, '.env.dev'));

const activeEnv = process.env.TEAMSFX_ENV;
if (activeEnv && activeEnv !== 'dev') {
  // TEAMSFX_ENV names a file inside env/, so keep it to a plain environment
  // name — a value with separators or '..' would read outside that folder.
  if (!/^[A-Za-z0-9_-]+$/.test(activeEnv)) {
    console.error(
      'Error: TEAMSFX_ENV is not a valid environment name (letters, digits, ' +
        'underscore and hyphen only).',
    );
    process.exit(1);
  }
  envConfig = {
    ...envConfig,
    ...readEnvFile(path.join(envDir, `.env.${activeEnv}`)),
  };
}

envConfig = {
  ...envConfig,
  ...process.env,
};

// TAB_ENDPOINT is the local debug tunnel. Honouring it everywhere would let a
// stale local value silently replace the deployed URLs, so it applies to the
// local environment only; every other environment uses CONTENT_URL and
// WEBSITE_URL, which stay distinct from each other.
const tunnelEndpoint =
  activeEnv === 'local' ? envConfig.TAB_ENDPOINT : undefined;
const contentUrl = tunnelEndpoint || envConfig.CONTENT_URL;
const websiteUrl = tunnelEndpoint || envConfig.WEBSITE_URL;
const urlSource = tunnelEndpoint
  ? 'TAB_ENDPOINT (local tunnel)'
  : 'CONTENT_URL / WEBSITE_URL';

// Check for missing environment variables
if (!contentUrl || !websiteUrl) {
  console.error(
    'Error: configure CONTENT_URL and WEBSITE_URL (or TAB_ENDPOINT for the ' +
      'local debug tunnel).',
  );
  process.exit(1);
}

const parseUrl = value => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

// Teams only loads tab pages over HTTPS, so reject anything else here rather
// than shipping a manifest the app package contract will refuse.
for (const [name, value] of [
  ['content', contentUrl],
  ['website', websiteUrl],
]) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:') {
    // The value itself is not echoed: environment values can carry secrets.
    console.error(
      `Error: the ${name} URL must be an absolute https:// URL — check ` +
        'TAB_ENDPOINT, CONTENT_URL and WEBSITE_URL.',
    );
    process.exit(1);
  }
}

// A Teams validDomains entry is a bare host: no scheme, port, path or
// wildcard, and it has to match the tab URL actually in use — so derive it
// from that URL. An explicit TAB_DOMAIN is only trusted for the local tunnel,
// where the tunnel task writes the endpoint and the domain together.
const contentHostname = parseUrl(contentUrl).hostname;
const tabDomain = (tunnelEndpoint && envConfig.TAB_DOMAIN) || contentHostname;
if (!/^[A-Za-z0-9.-]+$/.test(tabDomain)) {
  console.error(
    'Error: TAB_DOMAIN must be a bare hostname, with no scheme, port or path.',
  );
  process.exit(1);
}

// A TAB_DOMAIN that does not match the tab URL would leave the host Teams
// actually loads out of validDomains, so reject the mismatched pair instead
// of generating a manifest that cannot frame the tab.
if (tabDomain !== contentHostname) {
  console.error(
    'Error: TAB_DOMAIN does not match the host of the tab URL in use — the ' +
      'local tunnel task writes TAB_ENDPOINT and TAB_DOMAIN together.',
  );
  process.exit(1);
}

try {
  // Read the template file
  const templatePath = path.join(__dirname, 'manifest.template.json');
  const template = fs.readFileSync(templatePath, 'utf8');

  // Parse the template to a JSON object
  const manifest = JSON.parse(template);

  // Extract the current version
  const currentVersion = manifest.version;

  // Split the version into its components
  const versionParts = currentVersion.split('.').map(Number);

  // Increment the patch version (the last number) only for Test and Prod environments
  const environment = envConfig.ENVIRONMENT;
  if (environment === 'Test' || environment === 'Prod') {
    versionParts[2] += 1;
  }

  // Teams requires a numeric major.minor.patch version. A release can pin one
  // explicitly with APP_VERSION; otherwise the template version is used, with
  // the patch increment above applied for Test and Prod.
  const newVersion = envConfig.APP_VERSION || versionParts.join('.');
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    const source = envConfig.APP_VERSION
      ? 'APP_VERSION'
      : 'manifest.template.json';
    throw new Error(
      `Version from ${source} must use numeric major.minor.patch format.`,
    );
  }

  // Update the version number in the manifest
  manifest.version = newVersion;

  // Resolve the tab domain, then drop a duplicate if the same host is already
  // listed. The bot entry is still a ${{BOT_DOMAIN}} placeholder here, so a
  // tab sharing the bot host is de-duplicated by Teams Toolkit, not by this.
  manifest.validDomains = [
    ...new Set(
      manifest.validDomains.map(domain =>
        domain === '{{TAB_DOMAIN}}' ? tabDomain : domain,
      ),
    ),
  ];

  // Replace placeholders with environment variables
  const updatedManifest = substitutePlaceholders(
    JSON.stringify(manifest, null, 2),
    { CONTENT_URL: contentUrl, WEBSITE_URL: websiteUrl },
  );

  // Anything of this script's own form left over was never resolved.
  const unresolved = findUnresolvedPlaceholders(updatedManifest);
  if (unresolved.length > 0) {
    console.error(
      `Error: unresolved manifest placeholders: ${unresolved.join(', ')}.`,
    );
    process.exit(1);
  }

  // Write the final manifest.json file
  const outputPath = path.join(__dirname, 'appPackage', 'manifest.json');
  fs.writeFileSync(outputPath, updatedManifest, 'utf8');

  console.log(
    `manifest.json has been generated successfully with version ` +
      `${newVersion}, using tab URLs from ${urlSource}.`,
  );
} catch (error) {
  console.error('Error generating manifest.json:', error);
  process.exit(1);
}
