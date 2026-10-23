const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('pet uses the default dragon before state, on missing artwork and after reset', async () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
  const css = read('pet.css');
  assert.match(css, /#art\{background-image:url\("https:\/\/cdn\.keepwork\.com\/maisi\/magichaqi\/pet\/dragon_green_20260528090748\.webp"\);background-size:400% 400%;background-position:0% 0%\}/);
  assert.match(read('pet.html'), /<span id="art"><\/span>/);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, dataset: {}, children: [],
      classList: { toggle() {} }, addEventListener() {}, replaceChildren(...children) { this.children = children; } });
    return elements.get(id);
  };
  let publish;
  vm.runInNewContext(read('pet.js'), {
    window: { desktopPet: { subscribe(fn) { publish = fn; }, action: async () => ({ version: 1, context: '' }) } },
    document: { body: { style: { setProperty() {} } }, getElementById: element, addEventListener() {} },
  });
  await Promise.resolve();
  const expectDefault = () => {
    assert.equal(element('art').textContent, '');
    for (const key of ['backgroundImage', 'backgroundSize', 'backgroundPosition']) assert.equal(element('art').style[key], '');
  };
  expectDefault();
  assert.equal(element('status').textContent, '');
  publish({ version: 1, context: 'chat', pet: { imageData: 'data:image/webp;base64,YQ==', sheetUrl: 'https://cdn.keepwork.com/other.webp', bgSize: '400% 400%', bgPos: '66.667% 100%' } });
  assert.equal(element('art').style.backgroundImage, 'url("data:image/webp;base64,YQ==")');
  assert.equal(element('art').style.backgroundPosition, '66.667% 100%');
  assert.match(read('pet.html'), /img-src data: https:\/\/cdn.keepwork.com;/);
  publish({ version: 1, context: 'chat', pet: { sheetUrl: 'https://cdn.keepwork.com/custom.webp', bgSize: '400% 400%', bgPos: '100% 100%' } });
  assert.equal(element('art').style.backgroundImage, 'url("https://cdn.keepwork.com/custom.webp")');
  assert.equal(element('art').style.backgroundPosition, '100% 100%');
  publish({ version: 1, context: 'chat', pet: { sheetUrl: '', bgSize: '0% 0%', bgPos: '100% 100%' } });
  expectDefault();
  publish({ version: 1, context: '' });
  expectDefault();
});
