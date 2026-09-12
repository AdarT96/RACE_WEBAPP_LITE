import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleImport, scheduleImportTemplateCsv } from '../frontend/js/schedule-excel-adapter.js';

const catalogs = {
  '01':[{ id:'01', name:'ספרינטים' }, { id:'02', name:'מתח' }],
  '02':[{ id:'01', name:'ספרינטים' }, { id:'02', name:'מתח' }]
};

test('wide workbook matrix becomes the canonical schedule model', () => {
  const result = buildScheduleImport({ matrix:[
    ['תאריך', 'שעה', 'סוג', 'פעילות', 'צוות 1', 'צוות 2'],
    ['12/09/2026', '03:00', 'משותף', 'חימום', '', ''],
    ['12/09/2026', '03:10', 'תחנות', '', 'ספרינטים | 1', 'מתח | 2']
  ], stationCatalogByTeam:catalogs });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.schedule.teamIds, ['01', '02']);
  assert.equal(result.schedule.rows[1].assignments['02'].stationId, '02');
  assert.equal(result.schedule.rows[1].assignments['02'].routeNumber, '2');
});

test('unknown station is reported with workbook coordinates', () => {
  const result = buildScheduleImport({ matrix:[
    ['date', 'time', 'type', 'activity', 'team 1'],
    ['2026-09-12', '03:10', 'rotation', '', 'תחנה לא קיימת']
  ], stationCatalogByTeam:catalogs });
  assert.ok(result.errors[0].includes('שורה 2, צוות 1'));
});

test('template is UTF-8 friendly and includes requested teams', () => {
  const template = scheduleImportTemplateCsv([1, 3]);
  assert.ok(template.startsWith('\uFEFF'));
  assert.ok(template.includes('צוות 1'));
  assert.ok(template.includes('צוות 3'));
});

test('duplicate team columns are rejected before persistence', () => {
  const result = buildScheduleImport({ matrix:[
    ['תאריך', 'שעה', 'צוות 1', 'team 1'],
    ['2026-09-12', '03:10', 'ספרינטים', 'ספרינטים']
  ], stationCatalogByTeam:catalogs });
  assert.ok(result.errors.some(error => error.includes('יותר מעמודה אחת')));
});
