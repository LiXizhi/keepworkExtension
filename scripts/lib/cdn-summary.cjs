const fs = require('node:fs');

function cell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]|]/g, '\\$&');
}

function renderCdnSummary({ title, version, entries = [], note = '' }) {
  const lines = ['', `### ${cell(title)}`, ''];
  if (version) lines.push(`版本：${cell(version)}`, '');
  if (note) lines.push(cell(note), '');
  if (entries.length) {
    lines.push('| 文件 / 平台 | CDN 地址 | 大小（bytes） | SHA-256 |', '| --- | --- | ---: | --- |');
    for (const entry of entries) {
      const url = String(entry.url).replace(/[<>\s|]/g, encodeURIComponent);
      lines.push(`| ${cell(entry.name)} | [${cell(entry.url)}](<${url}>) | ${cell(entry.size)} | ${cell(entry.sha256)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// Reporting must not turn a completed CDN publication into a failed release.
function writeCdnSummary(release) {
  if (!process.env.GITHUB_STEP_SUMMARY) return false;
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderCdnSummary(release));
    return true;
  } catch (error) {
    process.stderr.write(`Unable to record CDN links in the Actions summary: ${error.message}\n`);
    return false;
  }
}

module.exports = { renderCdnSummary, writeCdnSummary };
