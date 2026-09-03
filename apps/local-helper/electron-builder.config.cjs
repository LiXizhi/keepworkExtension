const fs = require('node:fs');
const path = require('node:path');
const { createBuilderConfig } = require('./scripts/create-builder-config.cjs');

const localConfigPath = path.join(__dirname, 'build.local.json');
let localConfig = {};

if (fs.existsSync(localConfigPath)) {
  try {
    localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${localConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

module.exports = createBuilderConfig(localConfig, __dirname);
