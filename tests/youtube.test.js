import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseYouTube, thumbnailFor } from '../src/sources/youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTube', () => {
  describe('accepts', () => {
    it('a bare id', () => {
      assert.deepEqual(parseYouTube(ID), { videoId: ID, playlistId: null });
    });

    it('a watch link', () => {
      assert.equal(parseYouTube(`https://www.youtube.com/watch?v=${ID}`).videoId, ID);
    });

    it('a watch link with no scheme', () => {
      assert.equal(parseYouTube(`youtube.com/watch?v=${ID}`).videoId, ID);
    });

    it('a youtu.be share link', () => {
      assert.equal(parseYouTube(`https://youtu.be/${ID}`).videoId, ID);
    });

    it('the mobile, music and no-cookie hosts', () => {
      for (const host of ['m.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com']) {
        assert.equal(parseYouTube(`https://${host}/watch?v=${ID}`)?.videoId, ID, host);
      }
    });

    it('surrounding whitespace', () => {
      assert.equal(parseYouTube(`  https://youtu.be/${ID}  `).videoId, ID);
    });
  });

  describe('carries the playlist id when there is one', () => {
    it('from a watch link', () => {
      assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${ID}&list=PL123`), {
        videoId: ID,
        playlistId: 'PL123',
      });
    });

    it('from a share link', () => {
      assert.equal(parseYouTube(`https://youtu.be/${ID}?list=PL123`).playlistId, 'PL123');
    });
  });

  describe('rejects', () => {
    // Ordinary videos only — see the note on parseYouTube.
    it('Shorts, embed and live URL forms', () => {
      for (const form of ['shorts', 'embed', 'live', 'v']) {
        assert.equal(parseYouTube(`https://www.youtube.com/${form}/${ID}`), null, form);
      }
    });

    it('a watch link with no video id', () => {
      assert.equal(parseYouTube('https://www.youtube.com/watch?list=PL123'), null);
    });

    it('an id of the wrong length', () => {
      assert.equal(parseYouTube('short'), null);
      assert.equal(parseYouTube('waaaaaaaaaaytoolong'), null);
      assert.equal(parseYouTube(`https://www.youtube.com/watch?v=nope`), null);
    });

    it('another host entirely', () => {
      assert.equal(parseYouTube(`https://vimeo.com/watch?v=${ID}`), null);
      assert.equal(parseYouTube(`https://notyoutube.com/watch?v=${ID}`), null);
    });

    it('a host that merely ends in the right thing', () => {
      assert.equal(parseYouTube(`https://evilyoutube.com/watch?v=${ID}`), null);
    });

    it('nothing at all', () => {
      assert.equal(parseYouTube(''), null);
      assert.equal(parseYouTube('   '), null);
      assert.equal(parseYouTube(null), null);
      assert.equal(parseYouTube(undefined), null);
    });

    it('text that is not a URL', () => {
      assert.equal(parseYouTube('play something nice'), null);
    });
  });
});

describe('thumbnailFor', () => {
  it('points at the host the CSP allows', () => {
    assert.equal(thumbnailFor(ID), `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`);
  });
});
