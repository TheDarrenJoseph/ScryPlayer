import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatTime, joinMeta } from '../src/util/format.js';

describe('formatTime', () => {
  it('renders m:ss below the hour', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(9), '0:09');
    assert.equal(formatTime(61), '1:01');
    assert.equal(formatTime(599), '9:59');
  });

  it('renders h:mm:ss from the hour up', () => {
    assert.equal(formatTime(3600), '1:00:00');
    assert.equal(formatTime(3661), '1:01:01');
    assert.equal(formatTime(36000), '10:00:00');
  });

  it('truncates rather than rounds, so the clock never runs ahead', () => {
    assert.equal(formatTime(59.9), '0:59');
  });

  it('falls back to zero for anything that is not a real duration', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity, undefined, null, 'nope']) {
      assert.equal(formatTime(bad), '0:00', String(bad));
    }
  });
});

describe('joinMeta', () => {
  it('joins the parts it has', () => {
    assert.equal(joinMeta('Boards of Canada', 'Geogaddi'), 'Boards of Canada · Geogaddi');
  });

  it('skips the ones it does not', () => {
    assert.equal(joinMeta('Artist', null), 'Artist');
    assert.equal(joinMeta(undefined, 'Album'), 'Album');
    assert.equal(joinMeta('  ', 'Album'), 'Album', 'whitespace is not a part');
  });

  it('is empty when there is nothing to say', () => {
    assert.equal(joinMeta(), '');
    assert.equal(joinMeta(null, undefined, ''), '');
  });

  it('ignores parts that are not strings', () => {
    assert.equal(joinMeta('Artist', 42, {}), 'Artist');
  });
});
