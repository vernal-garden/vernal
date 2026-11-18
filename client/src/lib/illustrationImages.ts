// Loads growth-stage SVGs as HTMLImageElements for the Konva canvas. The art
// files carry only a viewBox, which some browsers rasterise at a tiny default
// size, so each file is fetched, given an explicit root size and loaded from a
// Blob URL. One load per URL and viewBox is shared by every marker; failures
// are cached too, so a missing file is not refetched on every render.
import { useEffect, useState } from 'react';

const SVG_SIZE = 240;

type Entry =
  | { status: 'loading'; promise: Promise<HTMLImageElement | null> }
  | { status: 'done'; image: HTMLImageElement | null };

const cache = new Map<string, Entry>();

// Sets width/height on the root <svg> start tag only, replacing any existing
// ones, and the viewBox too when one is given. Returns the text unchanged when
// there is no <svg> start tag. XML comments are skipped (an unclosed one runs
// to the end), and quoted attribute values may contain '>'.
export function withRootSize(svgText: string, size: number = SVG_SIZE, viewBox?: string): string {
  const scan = /<!--[\s\S]*?(?:-->|$)|<svg(?=[\s>/])(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  let match: RegExpExecArray | null;
  do {
    match = scan.exec(svgText);
  } while (match !== null && match[0].startsWith('<!--'));
  if (!match) return svgText;
  const tag = match[0];
  const end = /\/\s*>$|>$/.exec(tag)!;
  const selfClosing = end[0] !== '>';
  // Walk the attributes (quoted values kept whole) and drop width/height, and
  // viewBox when replacing it.
  const dropped = viewBox === undefined ? /^\s+(?:width|height)(?:\s*=|$)/i : /^\s+(?:width|height|viewBox)(?:\s*=|$)/i;
  const attrs = (tag.slice(4, end.index).match(/\s+[^\s=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"']+))?/g) ?? [])
    .filter(a => !dropped.test(a))
    .join('');
  const next = `<svg${attrs} width="${size}" height="${size}"${viewBox === undefined ? '' : ` viewBox="${viewBox}"`}${selfClosing ? '/>' : '>'}`;
  return svgText.slice(0, match.index) + next + svgText.slice(match.index + tag.length);
}

async function load(url: string, viewBox?: string): Promise<HTMLImageElement | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([withRootSize(text, SVG_SIZE, viewBox)], { type: 'image/svg+xml' }));
    return await new Promise<HTMLImageElement | null>(resolve => {
      const img = new Image();
      // The Blob URL is only needed until the image has decoded.
      img.onload = () => { URL.revokeObjectURL(blobUrl); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(null); };
      img.src = blobUrl;
    });
  } catch {
    return null;
  }
}

function keyOf(url: string, viewBox?: string | null): string {
  return `${url}|${viewBox ?? ''}`;
}

function request(url: string, viewBox?: string | null): Promise<HTMLImageElement | null> {
  const key = keyOf(url, viewBox);
  const entry = cache.get(key);
  if (entry) return entry.status === 'done' ? Promise.resolve(entry.image) : entry.promise;
  const promise = load(url, viewBox ?? undefined).then(image => {
    cache.set(key, { status: 'done', image });
    return image;
  });
  cache.set(key, { status: 'loading', promise });
  return promise;
}

function cached(key: string | null): HTMLImageElement | null {
  if (key === null) return null;
  const entry = cache.get(key);
  return entry?.status === 'done' ? entry.image : null;
}

// Null until the image has loaded, and on any failure (the caller then draws
// its fallback). A viewBox refits the art; the same file with and without one
// are separate cache entries.
export function useIllustration(url: string | null, viewBox?: string | null): HTMLImageElement | null {
  const key = url === null ? null : keyOf(url, viewBox);
  const [state, setState] = useState<{ key: string | null; image: HTMLImageElement | null }>(
    () => ({ key, image: cached(key) }),
  );

  useEffect(() => {
    if (url === null || key === null) return;
    if (cache.get(key)?.status === 'done') {
      const hit = cached(key);
      setState(prev => (prev.key === key && prev.image === hit ? prev : { key, image: hit }));
      return;
    }
    let active = true;
    request(url, viewBox).then(image => {
      if (active) setState({ key, image });
    });
    return () => { active = false; };
  }, [url, viewBox, key]);

  // A stale image from a previous URL or viewBox is never returned.
  return state.key === key ? state.image : cached(key);
}
