const path = require('path');

const getDataDir = () => {
  const configured = process.env.ZAPLIE_DATA_DIR;
  return configured ? path.resolve(configured) : __dirname;
};

const dataPath = (filename) => path.join(getDataDir(), filename);

module.exports = { dataPath, getDataDir };
