const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an element.
 *
 * Everything user-supplied — filenames, tag values, YouTube titles — reaches
 * the DOM through `textContent`, never `innerHTML`, so a track called
 * `<img onerror=…>` is just an oddly named track.
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function icon(d, className = 'row__icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

export const PATHS = {
  folder:
    'M4 6.5A1.5 1.5 0 0 1 5.5 5h3.9c.5 0 1 .24 1.25.66l.7 1.09c.14.21.37.34.62.34H18.5A1.5 1.5 0 0 1 20 8.6v8.9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
  note: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0m10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  video: 'M4 6h16v12H4zM10 9.2l5 2.8-5 2.8z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
};

/** The three rippling bars that mark the row currently playing. */
export function playingBars() {
  const wrap = el('div', 'bars');
  wrap.append(el('span'), el('span'), el('span'));
  return wrap;
}

export function emptyState(...lines) {
  const box = el('li', 'empty');
  lines.forEach((line, i) => {
    if (i) box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(line));
  });
  return box;
}
