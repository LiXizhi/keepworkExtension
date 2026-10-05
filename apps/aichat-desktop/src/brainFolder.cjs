const fs = require('node:fs');
const path = require('node:path');

// The host chooses this fixed location; no renderer-supplied path is accepted.
function defaultBrainFolder(files, documents, prepare = false) {
  const target = path.join(documents, 'MyBrain');
  if (!prepare) return { path: target, name: 'MyBrain' };
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('MyBrain 已被其他文件或链接占用，请选择其他文件夹');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(target, { recursive: true });
  }
  return files.grant(target);
}
module.exports = { defaultBrainFolder };
