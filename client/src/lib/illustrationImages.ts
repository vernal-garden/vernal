// Loads growth-stage SVGs as HTMLImageElements for the Konva canvas. The art
// files carry only a viewBox, which some browsers rasterise at a tiny default
// size, so each file is fetched, given an explicit root size and loaded from a
// Blob URL. One load per URL is shared by every marker; failures are cached
// too, so a missing file is not refetched on every render.
import { useEffect, useState } from 'react';

const SVG_SIZE = 240;

type Entry =
  | { status: 'loading'; promise: Promise<HTMLImageElement | null> }
  | { status: 'done'; image: HTMLImageElement | null };

const cache = new Map<string, Entry>();

// Sets width/height on the root <svg> start tag only, replacing any existing
// ones. Returns the text unchanged when there is no <svg> start tag. XML
// comments are skipped (an unclosed one runs to the end), and quoted attribute
// values may contain '>'.
export function withRootSize(svgText: string, size: number = SVG_SIZE): string {
  const scan = /<!--[\s\S]*?(?:-->|$)|<svg(?=[\s>/])(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  let match: RegExpExecArray | null;
  do {
    match = scan.exec(svgText);
  } while (match !== null && match[0].startsWith('<!--'));
  if (!match) return svgText;
  const tag = match[0];
  const end = /\/\s*>$|>$/.exec(tag)!;
  const selfClosing = end[0] !== '>';
  // Walk the attributes (quoted values kept whole) and drop width/height.
  const attrs = (tag.slice(4, end.index).match(/\s+[^\s=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"']+))?/g) ?? [])
    .filter(a => !/^\s+(?:width|height)(?:\s*=|$)/i.test(a))
    .join('');
  const next = `<svg${attrs} width="${size}" height="${size}"${selfClosing ? '/>' : '>'}`;
  return svgText.slice(0, match.index) + next + svgText.slice(match.index + tag.length);
}

async function load(url: string): Promise<HTMLImageElement | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([withRootSize(text)], { type: 'image/svg+xml' }));
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

function request(url: string): Promise<HTMLImageElement | null> {
  const entry = cache.get(url);
  if (entry) return entry.status === 'done' ? Promise.resolve(entry.image) : entry.promise;
  const promise = load(url).then(image => {
    cache.set(url, { status: 'done', image });
    return image;
  });
  cache.set(url, { status: 'loading', promise });
  return promise;
}

function cached(url: string | null): HTMLImageElement | null {
  if (url === null) return null;
  const entry = cache.get(url);
  return entry?.status === 'done' ? entry.image : null;
}

// Null until the image has loaded, and on any failure (the caller then draws
// its fallback).
export function useIllustration(url: string | null): HTMLImageElement | null {
  const [state, setState] = useState<{ url: string | null; image: HTMLImageElement | null }>(
    () => ({ url, image: cached(url) }),
  );

  useEffect(() => {
    if (url === null) return;
    if (cache.get(url)?.status === 'done') {
      const hit = cached(url);
      setState(prev => (prev.url === url && prev.image === hit ? prev : { url, image: hit }));
      return;
    }
    let active = true;
    request(url).then(image => {
      if (active) setState({ url, image });
    });
    return () => { active = false; };
  }, [url]);

  // A stale image from a previous URL is never returned.
  return state.url === url ? state.image : cached(url);
}
