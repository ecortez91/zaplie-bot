const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

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

const contentUrl = envConfig.TAB_ENDPOINT || envConfig.CONTENT_URL;
const websiteUrl = envConfig.TAB_ENDPOINT || envConfig.WEBSITE_URL;

// Check for missing environment variables
if (!contentUrl || !websiteUrl) {
  console.error(
    'Error: configure TAB_ENDPOINT, or both CONTENT_URL and WEBSITE_URL.',
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
// wildcard. Fall back to the tab URL's host so every environment resolves.
const tabDomain = envConfig.TAB_DOMAIN || parseUrl(contentUrl).hostname;
if (!/^[A-Za-z0-9.-]+$/.test(tabDomain)) {
  console.error(
    'Error: TAB_DOMAIN must be a bare hostname, with no scheme, port or path.',
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

  // Join the version parts back into a string
  const newVersion = versionParts.join('.');

  // Update the version number in the manifest
  manifest.version = newVersion;

  // Resolve the tab domain here (Teams Toolkit only resolves the ${{...}}
  // form) and drop the duplicate it creates when the tab shares the bot host.
  manifest.validDomains = [
    ...new Set(
      manifest.validDomains.map(domain =>
        domain === '{{TAB_DOMAIN}}' ? tabDomain : domain,
      ),
    ),
  ];

  // Replace placeholders with environment variables
  const updatedManifest = JSON.stringify(manifest, null, 2)
    .replace(/{{CONTENT_URL}}/g, contentUrl)
    .replace(/{{WEBSITE_URL}}/g, websiteUrl);

  // ${{...}} placeholders are resolved later by Teams Toolkit; anything this
  // script owns must be resolved by now.
  const unresolved = updatedManifest.match(/(?<!\$)\{\{[^{}]+\}\}/g);
  if (unresolved) {
    const names = [...new Set(unresolved)].join(', ');
    console.error(`Error: unresolved manifest placeholders: ${names}.`);
    process.exit(1);
  }

  // Write the final manifest.json file
  const outputPath = path.join(__dirname, 'appPackage', 'manifest.json');
  fs.writeFileSync(outputPath, updatedManifest, 'utf8');

  console.log(`manifest.json has been generated successfully with version ${newVersion}.`);
} catch (error) {
  console.error('Error generating manifest.json:', error);
  process.exit(1);
}
