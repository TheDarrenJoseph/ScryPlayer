import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { fetchVideoInfo, parseYouTube, thumbnailFor } from '../src/sources/youtube.js';

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

describe('fetchVideoInfo', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

  it('asks oEmbed for the watch URL, JSON form', async () => {
    let requested;
    globalThis.fetch = async (url) => {
      requested = url;
      return jsonResponse({ title: 'A Song', author_name: 'A Channel' });
    };

    await fetchVideoInfo(ID);

    assert.equal(
      requested,
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}&format=json`,
    );
  });

  it('resolves the title and channel name', async () => {
    globalThis.fetch = async () => jsonResponse({ title: '  A Song  ', author_name: '  A Channel  ' });

    assert.deepEqual(await fetchVideoInfo(ID), { title: 'A Song', artist: 'A Channel' });
  });

  it('resolves a null artist when oEmbed leaves it out', async () => {
    globalThis.fetch = async () => jsonResponse({ title: 'A Song' });

    assert.deepEqual(await fetchVideoInfo(ID), { title: 'A Song', artist: null });
  });

  it('resolves null on a non-OK response', async () => {
    globalThis.fetch = async () => jsonResponse({ title: 'A Song' }, false);

    assert.equal(await fetchVideoInfo(ID), null);
  });

  it('resolves null when there is no title to give', async () => {
    globalThis.fetch = async () => jsonResponse({});

    assert.equal(await fetchVideoInfo(ID), null);
  });

  it('resolves null rather than throwing when the network fails', async () => {
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    assert.equal(await fetchVideoInfo(ID), null);
  });

  it('resolves null on a response that is not JSON', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('not json');
      },
    });

    assert.equal(await fetchVideoInfo(ID), null);
  });
});
