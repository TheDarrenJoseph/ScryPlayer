import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { Emitter } from '../src/core/emitter.js';

describe('Emitter', () => {
  it('delivers a payload to every listener for the type', () => {
    const e = new Emitter();
    const seen = [];

    e.on('tick', (d) => seen.push(`a:${d.n}`));
    e.on('tick', (d) => seen.push(`b:${d.n}`));
    e.on('other', () => seen.push('other'));

    e.emit('tick', { n: 1 });

    assert.deepEqual(seen, ['a:1', 'b:1']);
  });

  it('is quiet when nothing is listening', () => {
    assert.doesNotThrow(() => new Emitter().emit('nobody-home', {}));
  });

  it('unsubscribes through the returned function and through off()', () => {
    const e = new Emitter();
    const seen = [];

    const stop = e.on('tick', () => seen.push('returned'));
    const named = () => seen.push('named');
    e.on('tick', named);

    e.emit('tick');
    stop();
    e.off('tick', named);
    e.emit('tick');

    assert.deepEqual(seen, ['returned', 'named'], 'second emit reaches nobody');
  });

  it('isolates a throwing listener so the rest still run', () => {
    const e = new Emitter();
    const seen = [];
    const error = mock.method(console, 'error', () => {});

    e.on('tick', () => {
      throw new Error('subscriber is broken');
    });
    e.on('tick', () => seen.push('still ran'));

    assert.doesNotThrow(() => e.emit('tick'));
    assert.deepEqual(seen, ['still ran']);
    assert.equal(error.mock.callCount(), 1, 'the failure is reported, not swallowed');

    error.mock.restore();
  });

  it('lets a listener unsubscribe itself mid-dispatch', () => {
    const e = new Emitter();
    let count = 0;

    const stop = e.on('tick', () => {
      count += 1;
      stop();
    });
    e.on('tick', () => {});

    assert.doesNotThrow(() => e.emit('tick'));
    e.emit('tick');

    assert.equal(count, 1, 'the self-removing listener does not run twice');
  });
});
