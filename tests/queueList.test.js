import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { click, installDom } from './helpers/dom.js';

let renderQueue;
let list;

before(async () => {
  installDom('<ol id="queue"></ol>');
  ({ renderQueue } = await import('../src/ui/queueList.js'));
});

beforeEach(() => {
  list = document.getElementById('queue');
  list.replaceChildren();
});

/** Minimal stand-in for a Queue — renderQueue reads only these two fields. */
const queue = (items, index = -1) => ({ items, index });

function render(q, overrides = {}) {
  renderQueue(list, q, {
    playing: true,
    onPlay: () => {},
    onRemove: () => {},
    emptyLines: ['Nothing here.', 'Add something.'],
    ...overrides,
  });
  return list.querySelectorAll('li.row');
}

const track = (over = {}) => ({ title: 'A Song', duration: 0, ...over });

describe('renderQueue', () => {
  describe('an empty queue', () => {
    it('shows the empty state instead of rows', () => {
      render(queue([]));

      assert.equal(list.querySelectorAll('li.row').length, 0);
      const empty = list.querySelector('li.empty');
      assert.match(empty.textContent, /Nothing here\.Add something\./);
    });
  });

  describe('rows', () => {
    it('renders one per track, in the order the user added them', () => {
      const rows = render(queue([track({ title: 'A' }), track({ title: 'B' })]));

      assert.equal(rows.length, 2);
      assert.equal(rows[0].querySelector('.row__name').textContent, 'A');
      assert.equal(rows[1].querySelector('.row__name').textContent, 'B');
    });

    it('numbers them from one', () => {
      const rows = render(queue([track(), track(), track()]));

      assert.deepEqual(
        [...rows].map((r) => r.querySelector('.row__index').textContent),
        ['1', '2', '3'],
      );
    });

    it('replaces the number with animated bars on the playing row', () => {
      const rows = render(queue([track(), track()], 1));

      assert.equal(rows[1].querySelector('.row__index'), null);
      assert.equal(rows[1].querySelectorAll('.bars span').length, 3);
      assert.equal(rows[0].querySelector('.row__index').textContent, '1');
    });

    it('falls back through title, filename and Unknown', () => {
      const rows = render(
        queue([
          track({ title: 'Tagged' }),
          track({ title: '', fileName: 'untagged.mp3' }),
          track({ title: '', fileName: '' }),
        ]),
      );

      assert.equal(rows[0].querySelector('.row__name').textContent, 'Tagged');
      assert.equal(rows[1].querySelector('.row__name').textContent, 'untagged.mp3');
      assert.equal(rows[2].querySelector('.row__name').textContent, 'Unknown');
    });

    it('shows a duration only once one is known', () => {
      const rows = render(queue([track({ duration: 185 }), track({ duration: 0 })]));

      assert.equal(rows[0].querySelector('.row__time').textContent, '3:05');
      assert.equal(rows[1].querySelector('.row__time'), null);
    });
  });

  describe('subtitles', () => {
    it('joins artist and album', () => {
      const rows = render(queue([track({ artist: 'Squarepusher', album: 'Ultravisitor' })]));
      assert.equal(rows[0].querySelector('.row__sub').textContent, 'Squarepusher · Ultravisitor');
    });

    it('names YouTube when there are no tags to show', () => {
      const rows = render(queue([track({ source: 'youtube' })]));
      assert.equal(rows[0].querySelector('.row__sub').textContent, 'YouTube');
    });

    it('is left off entirely for an untagged local file', () => {
      const rows = render(queue([track()]));
      assert.equal(rows[0].querySelector('.row__sub'), null);
    });
  });

  describe('state classes', () => {
    it('marks the playing row', () => {
      const rows = render(queue([track(), track()], 0));

      assert.ok(rows[0].classList.contains('is-playing'));
      assert.ok(!rows[1].classList.contains('is-playing'));
    });

    it('marks the playing row as paused when it is not sounding', () => {
      const rows = render(queue([track()], 0), { playing: false });
      assert.ok(rows[0].classList.contains('is-paused'));
    });

    it('marks a track the WebView cannot decode', () => {
      const rows = render(queue([track({ playable: false })]));

      assert.ok(rows[0].classList.contains('is-unplayable'));
      assert.equal(rows[0].querySelector('.row__sub').textContent, 'Unsupported format');
    });
  });

  describe('the remove button', () => {
    it('names the track it removes, for screen readers', () => {
      const rows = render(queue([track({ title: 'Iambic 9 Poetry' })]));
      const button = rows[0].querySelector('button');

      assert.equal(button.type, 'button');
      assert.equal(button.getAttribute('aria-label'), 'Remove Iambic 9 Poetry from queue');
    });

    it('says "track" when there is no title to name', () => {
      const rows = render(queue([{ duration: 0 }]));
      assert.equal(rows[0].querySelector('button').getAttribute('aria-label'), 'Remove track from queue');
    });

    it('reports the index it belongs to', () => {
      const removed = [];
      const rows = render(queue([track(), track(), track()]), {
        onRemove: (i) => removed.push(i),
      });

      click(rows[2].querySelector('button'));

      assert.deepEqual(removed, [2]);
    });

    it('does not also play the row it sits in', () => {
      const played = [];
      const removed = [];
      const rows = render(queue([track()]), {
        onPlay: (i) => played.push(i),
        onRemove: (i) => removed.push(i),
      });

      click(rows[0].querySelector('button'));

      assert.deepEqual(removed, [0]);
      assert.deepEqual(played, [], 'the click must not reach the row');
    });
  });

  describe('clicking a row', () => {
    it('plays that index', () => {
      const played = [];
      const rows = render(queue([track(), track()]), { onPlay: (i) => played.push(i) });

      click(rows[1]);

      assert.deepEqual(played, [1]);
    });
  });

  describe('re-rendering', () => {
    it('replaces the previous rows rather than appending to them', () => {
      render(queue([track(), track(), track()]));
      const rows = render(queue([track()]));

      assert.equal(rows.length, 1);
      assert.equal(list.children.length, 1);
    });

    it('drops the empty state once tracks arrive', () => {
      render(queue([]));
      render(queue([track()]));

      assert.equal(list.querySelector('li.empty'), null);
    });
  });

  describe('untrusted text', () => {
    it('renders a scripted title as text in both the name and the label', () => {
      const nasty = '<img src=x onerror="alert(1)">';
      const rows = render(queue([track({ title: nasty })]));

      assert.equal(rows[0].querySelector('.row__name').textContent, nasty);
      assert.equal(rows[0].querySelector('img'), null);
      assert.equal(
        rows[0].querySelector('button').getAttribute('aria-label'),
        `Remove ${nasty} from queue`,
      );
    });

    it('renders a scripted artist as text', () => {
      const rows = render(queue([track({ artist: '<script>x</script>', album: 'Album' })]));

      assert.equal(rows[0].querySelector('script'), null);
      assert.match(rows[0].querySelector('.row__sub').textContent, /<script>x<\/script> · Album/);
    });
  });
});
