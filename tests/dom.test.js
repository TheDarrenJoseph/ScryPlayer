import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { installDom } from './helpers/dom.js';

let el, emptyState, icon, PATHS, playingBars;

before(async () => {
  installDom();
  ({ el, emptyState, icon, PATHS, playingBars } = await import('../src/ui/dom.js'));
});

describe('el', () => {
  it('builds a tagged element', () => {
    assert.equal(el('span').tagName, 'SPAN');
  });

  it('applies a class and text when given them', () => {
    const node = el('div', 'row__name', 'Everything Ecstatic');
    assert.equal(node.className, 'row__name');
    assert.equal(node.textContent, 'Everything Ecstatic');
  });

  it('leaves out what it is not given', () => {
    const node = el('li');
    assert.equal(node.className, '');
    assert.equal(node.textContent, '');
  });

  it('keeps an empty string as text, since a blank subtitle is still a subtitle', () => {
    assert.equal(el('div', null, '').textContent, '');
  });

  // The claim in dom.js's docstring, and under Security notes in the README.
  it('renders markup in a title as text, never as markup', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const node = el('div', 'row__name', nasty);

    assert.equal(node.textContent, nasty, 'the text survives intact');
    assert.equal(node.querySelector('img'), null, 'but no element is created');
    assert.equal(node.innerHTML, '&lt;img src=x onerror="alert(1)"&gt;');
  });

  it('renders a script tag in a title as text', () => {
    const node = el('div', null, '<script>fetch("//evil")</script>');
    assert.equal(node.querySelector('script'), null);
    assert.equal(node.children.length, 0);
  });
});

describe('icon', () => {
  it('builds an SVG in the right namespace', () => {
    const svg = icon(PATHS.close);
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  });

  it('is hidden from assistive tech, since the control carries the label', () => {
    assert.equal(icon(PATHS.note).getAttribute('aria-hidden'), 'true');
  });

  it('carries the path it was given', () => {
    const svg = icon(PATHS.plus);
    assert.equal(svg.querySelector('path').getAttribute('d'), PATHS.plus);
  });

  it('takes a class, and can be given none', () => {
    assert.equal(icon(PATHS.folder).getAttribute('class'), 'row__icon');
    assert.equal(icon(PATHS.folder, 'custom').getAttribute('class'), 'custom');
    assert.equal(icon(PATHS.folder, '').getAttribute('class'), null);
  });
});

describe('playingBars', () => {
  it('is three bars to animate', () => {
    const bars = playingBars();
    assert.equal(bars.className, 'bars');
    assert.equal(bars.querySelectorAll('span').length, 3);
  });
});

describe('emptyState', () => {
  it('puts each line on its own row', () => {
    const box = emptyState('The queue is still.', 'Add a folder.');

    assert.equal(box.tagName, 'LI');
    assert.equal(box.className, 'empty');
    assert.equal(box.querySelectorAll('br').length, 1, 'a break between, not after');
    assert.match(box.textContent, /The queue is still\.Add a folder\./);
  });

  it('handles a single line and no lines', () => {
    assert.equal(emptyState('Alone').querySelectorAll('br').length, 0);
    assert.equal(emptyState().textContent, '');
  });

  it('renders its lines as text', () => {
    const box = emptyState('<b>bold</b>');
    assert.equal(box.querySelector('b'), null);
  });
});
