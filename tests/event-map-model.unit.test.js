import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_COMPRESSION_STEPS, MAP_MAX_DATA_LENGTH, MAP_RULES_MAX_DATA_LENGTH, buildMapRecord, canEditEventMap,
  mapImageSource, scaledSize, validateMapImage
} from '../frontend/js/event-map-model.js';

const image = (overrides = {}) => ({ data: 'QUJD', mimeType: 'image/jpeg', width: 800, height: 600, ...overrides });

test('admin and formation commander edit the map; other roles only view', () => {
  assert.equal(canEditEventMap('admin'), true);
  assert.equal(canEditEventMap('formation_commander'), true);
  for (const role of ['operator', 'evaluator', 'adjutant', '']) assert.equal(canEditEventMap(role), false);
});

test('map image validation mirrors the server limits', () => {
  assert.equal(validateMapImage(image()).ok, true);
  assert.equal(validateMapImage(image({ mimeType: 'image/svg+xml' })).ok, false, 'SVG can carry script');
  assert.equal(validateMapImage(image({ data: 'not base64!' })).ok, false);
  assert.equal(validateMapImage(image({ data: 'A'.repeat(MAP_MAX_DATA_LENGTH + 4) })).ok, false);
  assert.equal(validateMapImage(image({ width: 0 })).ok, false);
  assert.ok(MAP_MAX_DATA_LENGTH < MAP_RULES_MAX_DATA_LENGTH, 'a compressed image always passes the rules');
});

test('only a known image type with base64 data becomes an <img> source', () => {
  assert.equal(mapImageSource(image()), 'data:image/jpeg;base64,QUJD');
  assert.equal(mapImageSource(image({ mimeType: 'text/html' })), '');
  assert.equal(mapImageSource(image({ data: '"><script>' })), '');
  assert.equal(mapImageSource(null), '');
});

test('the stored record carries only the known fields', () => {
  assert.deepEqual(Object.keys(buildMapRecord(image(), { uid: 'u1', name: 'דנה' })).sort(),
    ['data', 'height', 'mimeType', 'schemaVersion', 'updatedBy', 'updatedByName', 'width']);
});

test('compression keeps the aspect ratio and never enlarges', () => {
  assert.deepEqual(scaledSize(4800, 2400, 2400), { width: 2400, height: 1200 });
  assert.deepEqual(scaledSize(800, 600, 2400), { width: 800, height: 600 });
  assert.ok(MAP_COMPRESSION_STEPS.every(([size, quality]) => size > 0 && quality > 0 && quality < 1));
});
