// filepath: tabs/backend/githubAppCredentials.js
// Credentials issued by the GitHub App manifest conversion, stored server-side
// only. This module is just the store: githubAppConfig.js chooses between
// these and the GITHUB_* env vars (env wins when set).
const fs = require('fs');
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');

const STORE_PATH = dataPath('github-app-credentials.json');

const getCredentials = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
};

const saveCredentials = (credentials) => {
  writeJsonSecure(STORE_PATH, credentials);
};

const clearCredentialsForTests = () => {
  fs.rmSync(STORE_PATH, { force: true });
};

module.exports = { getCredentials, saveCredentials, clearCredentialsForTests };
