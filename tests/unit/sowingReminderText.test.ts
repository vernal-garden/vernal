import { describe, it, expect } from 'vitest';
import { formatSowingReminder } from '../../client/src/lib/sowingReminderText';

const base = { gardenId: 1, gardenName: 'Back yard', season: 2027 };

describe('formatSowingReminder', () => {
  it('all groups', () => {
    const out = formatSowingReminder({
      ...base,
      open: {
        direct_sow: ['Pea'],
        indoor_start: ['Tomato', 'Pepper'],
        transplant_sown: ['Kale'],
        transplant: ['Basil'],
      },
      closing: [{ name: 'Lettuce', windowKind: 'direct_sow', endsOn: '2027-04-20' }],
    });
    expect(out).toHaveLength(2);
    expect(out![0].title).toBe('Planting time in Back yard');
    expect(out![0].lines).toEqual([
      'Start indoors: Tomato and Pepper',
      'Transplant: Basil',
      'Started Kale indoors? Harden them off, then plant out.',
      'Sow: Pea',
    ]);
    expect(out![1].title).toBe('Closing soon in Back yard');
    expect(out![1].lines).toEqual(['Sow Lettuce by Apr 20']);
  });

  it('one group', () => {
    const out = formatSowingReminder({ ...base, open: { direct_sow: ['Pea'] } });
    expect(out).toEqual([{ title: 'Planting time in Back yard', lines: ['Sow: Pea'] }]);
  });

  it('transplant_sown only', () => {
    const out = formatSowingReminder({ ...base, open: { transplant_sown: ['Kale'] } });
    expect(out![0].title).toBe('Planting time in Back yard');
    expect(out![0].lines).toEqual(['Started Kale indoors? Harden them off, then plant out.']);
  });

  it('closing only', () => {
    const out = formatSowingReminder({
      ...base,
      closing: [{ name: 'Kale', windowKind: 'transplant', endsOn: '2027-05-01' }],
    });
    expect(out).toHaveLength(1);
    expect(out![0].title).toBe('Closing soon in Back yard');
  });

  it('two closing end dates make two lines', () => {
    const out = formatSowingReminder({
      ...base,
      closing: [
        { name: 'A', windowKind: 'direct_sow', endsOn: '2027-05-02' },
        { name: 'B', windowKind: 'direct_sow', endsOn: '2027-05-01' },
        { name: 'C', windowKind: 'direct_sow', endsOn: '2027-05-01' },
      ],
    });
    expect(out![0].lines).toEqual(['Sow B and C by May 1', 'Sow A by May 2']);
  });

  it('skips unknown and empty groups', () => {
    expect(
      formatSowingReminder({
        ...base,
        open: { bogus: ['x'], sow: [], direct_sow: [] },
        closing: [{ name: 'X', windowKind: 'harvest', endsOn: '2027-05-01' }],
      }),
    ).toBeNull();
  });

  it('returns null when nothing renders', () => {
    expect(formatSowingReminder({})).toBeNull();
    expect(formatSowingReminder(base)).toBeNull();
    expect(formatSowingReminder(null)).toBeNull();
  });
});
