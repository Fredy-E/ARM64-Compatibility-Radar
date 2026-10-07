const assert = require('node:assert/strict');
const radar = require('../catalog.js');

assert.throws(() => radar.validate([{ id: 'x', name: 'test', status: 'tested', source: '', date: '', sample: false }]));
const valid = [{ id: 'x', name: 'Native editor', type: 'app', status: 'reported', source: 'https://example.com/evidence', date: '2026-10-01', sample: true }];
assert.equal(radar.validate(valid).length, 1);
assert.equal(radar.filter(valid, 'native', 'reported', 'app').length, 1);
console.log('Passed: evidence-catalog validation and filtering.');
