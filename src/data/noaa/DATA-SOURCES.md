# NOAA frost station data

`conus_last32_by_station.csv` and the `frostStations.json` built from it
are U.S. government work in the public domain. They are not covered by
this repository's AGPL licence. The code that reads them is.

Palecki, Michael; Durre, Imke; Applequist, Scott; Arguez, Anthony;
Lawrimore, Jay (2021). U.S. Climate Normals 2020: U.S. Annual/Seasonal
Climate Normals (1991-2020). Subset used: last spring 32°F freeze dates at
50% probability, and yearly freeze chance, by station. NOAA National
Centers for Environmental Information. Dataset.
https://doi.org/10.25921/4ek7-fk11. Accessed October 24, 2026.

Vernal turned this data into its own table. NOAA has not reviewed or
endorsed it.

The CSV was prepared by Vernal's research (stations in the lower 48 with a
published 50% date, placed in USDA 2023 zones). Rebuild the JSON with
`npx tsx scripts/build-frost-stations.ts`.
