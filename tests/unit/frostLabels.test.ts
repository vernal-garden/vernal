import { describe, it, expect } from 'vitest';
import {
  framePrompt,
  frostState,
  springBannerText,
  stripFrostLine,
  windowSourceLabel,
} from '../../client/src/lib/frostLabels';
import type { GuideGarden } from '../../client/src/types/plantingGuide';

type Frost = GuideGarden['frost'];

function frost(extra: Partial<Frost> = {}): Frost {
  return {
    lastSpringFrost: null,
    firstFallFrost: null,
    frostSource: null,
    frostBasis: null,
    frostFree: false,
    stationName: null,
    ...extra,
  };
}

const own = frost({ lastSpringFrost: '2027-04-10', firstFallFrost: '2027-10-20', frostSource: 'account_frost' });
const noaa = frost({ lastSpringFrost: '2027-04-24', firstFallFrost: '2027-10-15', frostSource: 'zone_estimate', frostBasis: 'noaa' });
const rough = frost({ lastSpringFrost: '2027-05-18', firstFallFrost: '2027-09-10', frostSource: 'zone_estimate', frostBasis: 'rough' });
const station = frost({ lastSpringFrost: '2027-04-26', firstFallFrost: '2027-10-12', frostSource: 'zone_estimate', frostBasis: 'station', stationName: 'Spokane Intl Airport' });
const stationFrostFree = frost({ frostFree: true, frostBasis: 'station', stationName: 'Borrego Desert Park' });
const frostFree = frost({ frostFree: true });
const none = frost();

describe('frostState', () => {
  it('returns own for an account frost date', () => {
    expect(frostState(own)).toBe('own');
  });

  it('returns noaa for a NOAA zone estimate', () => {
    expect(frostState(noaa)).toBe('noaa');
  });

  it('returns rough for a rough zone estimate', () => {
    expect(frostState(rough)).toBe('rough');
  });

  it('returns station for a station estimate', () => {
    expect(frostState(station)).toBe('station');
  });

  it('returns stationFrostFree for a rare-freeze station', () => {
    expect(frostState(stationFrostFree)).toBe('stationFrostFree');
  });

  it('returns frostFree for a frost-free garden', () => {
    expect(frostState(frostFree)).toBe('frostFree');
  });

  it('returns none when there is no frost data', () => {
    expect(frostState(none)).toBe('none');
  });
});

describe('stripFrostLine', () => {
  it('shows the account date', () => {
    expect(stripFrostLine(own, '7b')).toBe('Last frost Apr 10 (your date)');
  });

  it('names NOAA records for a zone 3-9 estimate', () => {
    expect(stripFrostLine(noaa, '6b')).toBe('About Apr 24, estimated from NOAA records for zone 6');
  });

  it('calls a zone 1-2 estimate rough', () => {
    expect(stripFrostLine(rough, '2')).toBe('About May 18, a rough estimate for zone 2');
  });

  it('names the weather station record for a station estimate', () => {
    expect(stripFrostLine(station, '6b')).toBe('About Apr 26, from the Spokane Intl Airport weather record');
  });

  it('says frost is rare at a rare-freeze station', () => {
    expect(stripFrostLine(stationFrostFree, '10a')).toBe('Frost is rare at the Borrego Desert Park weather station.');
  });

  it('returns null for a station state missing its station name', () => {
    expect(stripFrostLine({ ...station, stationName: null }, '6b')).toBeNull();
    expect(stripFrostLine({ ...stationFrostFree, stationName: null }, '10a')).toBeNull();
  });

  it('says a frost-free zone usually has no frost', () => {
    expect(stripFrostLine(frostFree, '10a')).toBe('No last frost set. Zone 10 is usually frost-free.');
  });

  it('asks for manual data when there is none', () => {
    expect(stripFrostLine(none, '6b')).toBe('No data, add manually');
  });

  it('returns null when the zone has no number', () => {
    expect(stripFrostLine(noaa, 'unknown')).toBeNull();
  });
});

describe('framePrompt', () => {
  it('offers to set your own date for a NOAA estimate', () => {
    expect(framePrompt(noaa)).toEqual({ text: 'These windows use an estimated last frost.', link: 'Set your own date' });
  });

  it('offers to set your own date for a rough estimate', () => {
    expect(framePrompt(rough)).toEqual({ text: 'These windows use an estimated last frost.', link: 'Set your own date' });
  });

  it('offers to set your own date for a station estimate', () => {
    expect(framePrompt(station)).toEqual({ text: 'These windows use an estimated last frost.', link: 'Set your own date' });
  });

  it('offers a last frost date at a rare-freeze station', () => {
    expect(framePrompt(stationFrostFree)).toEqual({ text: 'Get frost some years?', link: 'Set a last frost date' });
  });

  it('offers a last frost date to a frost-free garden', () => {
    expect(framePrompt(frostFree)).toEqual({ text: 'Get frost some years?', link: 'Set a last frost date' });
  });

  it('returns null for an account date', () => {
    expect(framePrompt(own)).toBeNull();
  });

  it('returns null when there is no frost data', () => {
    expect(framePrompt(none)).toBeNull();
  });
});

describe('windowSourceLabel', () => {
  it('labels every window source', () => {
    expect(windowSourceLabel('custom')).toBe('Your custom date');
    expect(windowSourceLabel('account_frost')).toBe('From your last frost date');
    expect(windowSourceLabel('zone_estimate')).toBe('Estimated from your last frost');
    expect(windowSourceLabel(null)).toBe('No data, add manually');
  });
});

describe('springBannerText', () => {
  it('states the account date with no link', () => {
    expect(springBannerText(own)).toEqual({ text: 'Your last frost date is April 10. Indoor starts due soon.', link: null });
  });

  it('calls a NOAA estimate estimated and links to set your own date', () => {
    expect(springBannerText(noaa)).toEqual({
      text: 'Your estimated last frost is about April 24. Indoor starts due soon.',
      link: 'Set your own date',
    });
  });

  it('treats a station estimate as an estimate', () => {
    expect(springBannerText(station)).toEqual({
      text: 'Your estimated last frost is about April 26. Indoor starts due soon.',
      link: 'Set your own date',
    });
  });

  it('returns null for a frost-free garden', () => {
    expect(springBannerText(frostFree)).toBeNull();
  });
});
