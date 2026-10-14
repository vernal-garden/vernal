// Station providers offered in the connect flows; only Tempest is live.
export const PROVIDERS = [
  { key: 'pws_tempest', label: 'Tempest WeatherFlow', enabled: true },
  { key: 'ambient', label: 'Ambient Weather', enabled: false },
  { key: 'davis', label: 'Davis Instruments', enabled: false },
  { key: 'other', label: 'Other', enabled: false },
] as const;
