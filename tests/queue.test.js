import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Queue } from '../src/core/queue.js';

/**
 * A queue holding tracks named A, B, C…, with nothing cued.
 *
 * Cues before shuffling, the order a listener does it in — which matters,
 * because shuffling with a track cued pins it to the head of the playback
 * order, and shuffling with nothing cued does not.
 */
function queueOf(names, { index = -1, shuffle = false, repeat = 'off' } = {}) {
  const q = new Queue('test');
  q.add(names.split('').map((title) => ({ title })));
  if (repeat !== 'off') q.setRepeat(repeat);
  if (index !== -1) q.setIndex(index);
  if (shuffle) q.setShuffle(true);
  return q;
}

const titles = (q) => q.items.map((t) => t.title).join('');

describe('Queue', () => {
  describe('add', () => {
    it('appends and reports how many arrived', () => {
      const q = queueOf('AB');
      assert.equal(q.add([{ title: 'C' }, { title: 'D' }]), 2);
      assert.equal(titles(q), 'ABCD');
    });

    it('accepts a lone track as well as an array', () => {
      const q = queueOf('A');
      q.add({ title: 'B' });
      assert.equal(titles(q), 'AB');
    });

    it('ignores an empty add rather than emitting a change', () => {
      const q = queueOf('A');
      let changes = 0;
      q.on('change', () => (changes += 1));

      assert.equal(q.add([]), 0);
      assert.equal(changes, 0);
    });
  });

  describe('removeAt', () => {
    it('shifts the cursor down when the removed track sits before it', () => {
      const q = queueOf('ABC', { index: 2 });
      q.removeAt(0);

      assert.equal(titles(q), 'BC');
      assert.equal(q.current().title, 'C', 'still the same track');
    });

    it('leaves the cursor alone when the removed track sits after it', () => {
      const q = queueOf('ABC', { index: 0 });
      q.removeAt(2);

      assert.equal(titles(q), 'AB');
      assert.equal(q.current().title, 'A');
    });

    it('keeps the cursor on the slot when the cued track is removed', () => {
      const q = queueOf('ABC', { index: 1 });
      q.removeAt(1);

      assert.equal(titles(q), 'AC');
      assert.equal(q.index, 1);
      assert.equal(q.current().title, 'C', 'the slot now holds what followed');
    });

    it('clamps to the end when the last track is removed', () => {
      const q = queueOf('ABC', { index: 2 });
      q.removeAt(2);

      assert.equal(q.index, 1);
      assert.equal(q.current().title, 'B');
    });

    it('leaves an empty queue with nothing cued', () => {
      const q = queueOf('A', { index: 0 });
      q.removeAt(0);

      assert.equal(q.length, 0);
      assert.equal(q.index, -1);
      assert.equal(q.current(), null);
    });

    it('ignores an index outside the queue', () => {
      const q = queueOf('AB');
      q.removeAt(-1);
      q.removeAt(9);
      assert.equal(titles(q), 'AB');
    });
  });

  describe('clear', () => {
    it('empties the queue and uncues', () => {
      const q = queueOf('ABC', { index: 1 });
      q.clear();

      assert.equal(q.length, 0);
      assert.equal(q.index, -1);
      assert.equal(q.current(), null);
    });
  });

  describe('setIndex', () => {
    it('accepts -1 as "nothing cued" but refuses past the end', () => {
      const q = queueOf('AB', { index: 1 });

      q.setIndex(-1);
      assert.equal(q.index, -1);

      q.setIndex(5);
      assert.equal(q.index, -1, 'out of range is ignored');
    });
  });

  describe('nextIndex', () => {
    it('walks forward in order', () => {
      const q = queueOf('ABC', { index: 0 });
      assert.equal(q.nextIndex(true), 1);
    });

    it('stops at the end when a track ended and repeat is off', () => {
      const q = queueOf('ABC', { index: 2 });
      assert.equal(q.nextIndex(true), null);
    });

    it('wraps at the end when the user pressed Next, even with repeat off', () => {
      const q = queueOf('ABC', { index: 2 });
      assert.equal(q.nextIndex(false), 0, 'a manual Next always wraps');
    });

    it('wraps at the end when a track ended and repeat is all', () => {
      const q = queueOf('ABC', { index: 2, repeat: 'all' });
      assert.equal(q.nextIndex(true), 0);
    });

    it('repeats the same track only when it ended on its own', () => {
      const q = queueOf('ABC', { index: 1, repeat: 'one' });

      assert.equal(q.nextIndex(true), 1, 'repeat-one holds the track');
      assert.equal(q.nextIndex(false), 2, 'a manual Next still moves on');
    });

    it('has nowhere to go in an empty queue', () => {
      assert.equal(new Queue('test').nextIndex(true), null);
    });
  });

  describe('prevIndex', () => {
    it('walks back, wrapping to the end', () => {
      const q = queueOf('ABC', { index: 1 });
      assert.equal(q.prevIndex(), 0);

      q.setIndex(0);
      assert.equal(q.prevIndex(), 2, 'wraps around the start');
    });

    it('has nowhere to go in an empty queue', () => {
      assert.equal(new Queue('test').prevIndex(), null);
    });
  });

  describe('shuffle', () => {
    it('leaves the visible order alone', () => {
      const q = queueOf('ABCDEFGH');
      q.setShuffle(true);
      assert.equal(titles(q), 'ABCDEFGH', 'the pane shows what the user added');
    });

    it('visits every track exactly once before wrapping', () => {
      // Cueing before shuffling pins the current track to the head of the
      // order, so a full pass is exactly the remaining seven steps.
      const q = queueOf('ABCDEFGH', { index: 0, shuffle: true });

      const seen = [q.index];
      for (let i = 0; i < 7; i++) {
        const next = q.nextIndex(true);
        assert.notEqual(next, null, `the pass ended early, after ${seen.length}`);
        q.setIndex(next);
        seen.push(next);
      }

      assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.equal(q.nextIndex(true), null, 'and then the pass is over');
    });

    it('does not yank the playing track out from under the listener', () => {
      // Repeated because the permutation is random.
      for (let run = 0; run < 50; run++) {
        const q = queueOf('ABCDEFGH', { index: 3 });
        q.setShuffle(true);
        assert.equal(q.current().title, 'D', 'the cued track survives the shuffle');
      }
    });
  });

  describe('restore', () => {
    it('brings back items, cursor and modes', () => {
      const q = new Queue('test');
      q.restore({
        items: [{ title: 'A' }, { title: 'B' }],
        index: 1,
        repeat: 'all',
        shuffle: true,
      });

      assert.equal(titles(q), 'AB');
      assert.equal(q.index, 1);
      assert.equal(q.repeat, 'all');
      assert.equal(q.shuffle, true);
    });

    it('drops a cursor that points past the restored items', () => {
      const q = new Queue('test');
      q.restore({ items: [{ title: 'A' }], index: 7 });
      assert.equal(q.index, -1);
    });

    it('falls back to safe modes when the snapshot is nonsense', () => {
      const q = new Queue('test');
      q.restore({ items: [{ title: 'A' }], index: 'nope', repeat: 'sideways' });

      assert.equal(q.index, -1);
      assert.equal(q.repeat, 'off');
    });

    it('ignores a snapshot with no items array', () => {
      const q = queueOf('AB');
      q.restore(null);
      q.restore({ index: 0 });
      assert.equal(titles(q), 'AB', 'the existing queue is left alone');
    });

    it('round-trips through toJSON', () => {
      const before = queueOf('ABC', { index: 1, repeat: 'one' });
      const after = new Queue('test');
      after.restore(JSON.parse(JSON.stringify(before)));

      assert.equal(titles(after), 'ABC');
      assert.equal(after.index, 1);
      assert.equal(after.repeat, 'one');
    });
  });

  describe('change events', () => {
    it('fires for the mutations the UI repaints on', () => {
      const q = queueOf('ABC');
      let changes = 0;
      q.on('change', () => (changes += 1));

      q.add({ title: 'D' });
      q.removeAt(0);
      q.setIndex(1);
      q.setShuffle(true);
      q.setRepeat('all');
      q.clear();

      assert.equal(changes, 6);
    });
  });
});
