'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {buildRuntime} = require('./bundle.cjs');

function harness() {
  const images = [], cells = {}, rowHeights = new Map();
  class Image {
    constructor(title = '') { this.title = title; images.push(this); }
    getAltTextTitle() { return this.title; }
    setAltTextTitle(value) { this.title = value; return this; }
    setAltTextDescription(value) { this.description = value; return this; }
    setAnchorCell(value) { this.anchor = value.address; return this; }
    setAnchorCellXOffset(value) { this.x = value; return this; }
    setAnchorCellYOffset(value) { this.y = value; return this; }
    setWidth(value) { this.width = value; return this; }
    setHeight(value) { this.height = value; return this; }
    assignScript(value) { this.script = value; return this; }
    getScript() { return this.script; }
    replace(blob) { this.blob = blob; return this; }
    remove() { images.splice(images.indexOf(this), 1); }
  }
  const row = Array(12).fill(''), formulas = Array(12).fill('');
  const panel = {
    getSheetId: () => 202609250,
    getRange(address) {
      if (address === 'A4:L4') return {getValues: () => [row], getFormulas: () => [formulas]};
      return cells[address] ||= {address};
    },
    getImages: () => [...images],
    getRowHeight: row => rowHeights.get(row) || 20,
    setRowHeight: (row, height) => rowHeights.set(row, height),
    insertImage: blob => new Image().replace(blob),
  };
  const context = vm.createContext({
    Utilities: {
      base64Decode: value => [...Buffer.from(value, 'base64')],
      newBlob: (bytes, mime, name) => ({bytes, mime, name}),
    },
    UrlFetchApp: {fetch() { throw new Error('Installing controls must not make network calls'); }},
  });
  vm.runInContext(Object.values(buildRuntime().files).join('\n'), context);
  context.registryPublishingPanel_ = () => panel;
  return {context, panel, images, row, formulas, rowHeights, Image};
}

test('the sheet gets three direct actions, with publication bound to the native confirmation dialog', () => {
  const h = harness();
  h.context.registryUiInstallActionButtons();
  assert.deepEqual(h.images.map(i => [i.anchor, i.getScript()]), [
    ['A4', 'registryPublishingUpdatePreviewFromMenu'],
    ['E4', 'registryUiPublishProductionDialog'],
    ['I4', 'registryPublishingRefreshStatusFromMenu'],
  ]);
  assert.deepEqual(h.images.map(i => i.description), ['Update preview', 'Publish to production', 'Refresh status']);
  assert.equal(h.rowHeights.get(4), 56);
  for (const image of h.images) {
    assert.equal(image.width, 220); assert.equal(image.height, 36);
    assert.deepEqual(image.blob.bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.deepEqual(h.row, Array(12).fill(''));
});

test('reinstalling is idempotent and removes only installer-owned obsolete or duplicate controls', () => {
  const h = harness(), unrelated = new h.Image('User illustration');
  const legacy = new h.Image('AIS_REGISTRY_ACTION_BUTTON_V1');
  h.context.registryUiInstallActionButtons();
  assert.ok(!h.images.includes(legacy));
  new h.Image(h.images[1].title);
  h.context.registryUiInstallActionButtons();
  assert.equal(h.images.length, 4); assert.ok(h.images.includes(unrelated));
  assert.equal(h.images.filter(i => i.script === 'registryUiPublishProductionDialog').length, 1);
});

test('installation refuses to cover existing cells or a different control sheet', () => {
  for (const change of [h => h.row[5] = 'User note', h => h.formulas[5] = '=IF(TRUE,"","")',
    h => h.panel.getSheetId = () => 99]) {
    const h = harness(); change(h);
    assert.throws(() => h.context.registryUiInstallActionButtons(), /action row|control panel/i);
    assert.equal(h.images.length, 0); assert.equal(h.rowHeights.size, 0);
  }
});

test('invalid artwork fails before changing the worksheet', () => {
  const h = harness(); h.context.REGISTRY_UI_BUTTON_ARTWORK.preview = '';
  assert.throws(() => h.context.registryUiInstallActionButtons(), /artwork/i);
  assert.equal(h.images.length, 0); assert.equal(h.rowHeights.size, 0);
});
