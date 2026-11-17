import { describe, it, expect } from 'vitest';
import { withRootSize } from '../../client/src/lib/illustrationImages';

const SIZE = 'width="240" height="240"';

describe('withRootSize', () => {
  it('adds width and height to a plain root and keeps its other attributes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle r="4"/></svg>';
    expect(withRootSize(svg)).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" ${SIZE}><circle r="4"/></svg>`,
    );
  });

  it('replaces double-quoted width and height', () => {
    expect(withRootSize('<svg width="64" height="64" viewBox="0 0 64 64"></svg>'))
      .toBe(`<svg viewBox="0 0 64 64" ${SIZE}></svg>`);
  });

  it('replaces single-quoted width and height', () => {
    expect(withRootSize("<svg width='64' height='64'></svg>")).toBe(`<svg ${SIZE}></svg>`);
  });

  it('replaces unquoted width and height', () => {
    expect(withRootSize('<svg width=64 height=64 viewBox="0 0 1 1"></svg>'))
      .toBe(`<svg viewBox="0 0 1 1" ${SIZE}></svg>`);
  });

  it('replaces width and height with spaces around =', () => {
    expect(withRootSize('<svg width = "64" height =\'64\' id="a"></svg>')).toBe(`<svg id="a" ${SIZE}></svg>`);
  });

  it('replaces uppercase WIDTH and HEIGHT', () => {
    expect(withRootSize('<svg WIDTH="64" Height="64"></svg>')).toBe(`<svg ${SIZE}></svg>`);
  });

  it('never duplicates width or height', () => {
    const out = withRootSize('<svg width="1" height="2" width="3"></svg>');
    expect(out.match(/\swidth=/g)).toHaveLength(1);
    expect(out.match(/\sheight=/g)).toHaveLength(1);
  });

  it('keeps stroke-width, data-width and min-height', () => {
    expect(withRootSize('<svg stroke-width="2" data-width="9" min-height="3"></svg>'))
      .toBe(`<svg stroke-width="2" data-width="9" min-height="3" ${SIZE}></svg>`);
  });

  it('uses a custom size', () => {
    expect(withRootSize('<svg viewBox="0 0 1 1"></svg>', 48)).toBe('<svg viewBox="0 0 1 1" width="48" height="48"></svg>');
  });

  it('handles a self-closing root with attributes', () => {
    expect(withRootSize('<svg viewBox="0 0 1 1" width="5" />')).toBe(`<svg viewBox="0 0 1 1" ${SIZE}/>`);
  });

  it('handles a bare self-closing <svg/>', () => {
    expect(withRootSize('<svg/>')).toBe(`<svg ${SIZE}/>`);
  });

  it('handles an XML prolog and DOCTYPE before the root', () => {
    const head = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
    expect(withRootSize(`${head}<svg viewBox="0 0 1 1"></svg>`)).toBe(`${head}<svg viewBox="0 0 1 1" ${SIZE}></svg>`);
  });

  it('changes only the first <svg> and keeps a nested one', () => {
    expect(withRootSize('<svg viewBox="0 0 1 1"><svg width="10" height="10"></svg></svg>'))
      .toBe(`<svg viewBox="0 0 1 1" ${SIZE}><svg width="10" height="10"></svg></svg>`);
  });

  it('does not match <svgfoo> and leaves </svg> untouched', () => {
    expect(withRootSize('<svgfoo width="1"></svgfoo><svg></svg>')).toBe(`<svgfoo width="1"></svgfoo><svg ${SIZE}></svg>`);
    expect(withRootSize('</svg>')).toBe('</svg>');
  });

  it('returns the input unchanged when there is no <svg>', () => {
    expect(withRootSize('<div width="3">no art</div>')).toBe('<div width="3">no art</div>');
    expect(withRootSize('')).toBe('');
  });

  it('handles attributes over several lines', () => {
    expect(withRootSize('<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="64"\n  viewBox="0 0 64 64"\n>\n</svg>'))
      .toBe(`<svg\n  xmlns="http://www.w3.org/2000/svg"\n  viewBox="0 0 64 64" ${SIZE}>\n</svg>`);
  });

  it('keeps a quoted value containing >', () => {
    expect(withRootSize('<svg aria-label="a > b" width="9"><g/></svg>')).toBe(`<svg aria-label="a > b" ${SIZE}><g/></svg>`);
  });

  it('skips a comment containing <svg> before the root and leaves the comment text alone', () => {
    const comment = '<!-- old: <svg width="1" height="1"> -->';
    expect(withRootSize(`${comment}\n<svg viewBox="0 0 1 1"></svg>`)).toBe(`${comment}\n<svg viewBox="0 0 1 1" ${SIZE}></svg>`);
  });
});
