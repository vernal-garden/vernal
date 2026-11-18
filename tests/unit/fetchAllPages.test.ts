import { describe, it, expect, vi } from 'vitest';
import { fetchAllPages } from '../../client/src/lib/fetchAllPages';

// Fake server: `count` rows numbered 0..count-1, paged by offset/limit.
function makeFetcher(count: number, total: number | string = count) {
  return vi.fn(async (offset: number, limit: number) => ({
    data: Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => offset + i),
    total,
  }));
}

describe('fetchAllPages', () => {
  it('collects every page until total', async () => {
    const fetchPage = makeFetcher(78);
    const rows = await fetchAllPages(fetchPage, 50);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 50);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 50, 50);
    expect(rows).toEqual(Array.from({ length: 78 }, (_, i) => i));
  });

  it('accepts total as a string', async () => {
    const fetchPage = makeFetcher(78, '78');
    const rows = await fetchAllPages(fetchPage, 50);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 50);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 50, 50);
    expect(rows).toHaveLength(78);
  });

  it('stops on an empty page', async () => {
    const fetchPage = vi.fn(async (offset: number, _limit: number) => ({
      data: offset === 0 ? Array.from({ length: 50 }, (_, i) => i) : [],
      total: 100,
    }));
    const rows = await fetchAllPages(fetchPage, 50);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 50, 50);
    expect(rows).toHaveLength(50);
  });

  it('stops at maxPages', async () => {
    const fetchPage = makeFetcher(1000);
    const rows = await fetchAllPages(fetchPage, 10, 3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 20, 10);
    expect(rows).toHaveLength(30);
  });

  it('single short page', async () => {
    const fetchPage = makeFetcher(5);
    const rows = await fetchAllPages(fetchPage, 50);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(0, 50);
    expect(rows).toHaveLength(5);
  });
});
