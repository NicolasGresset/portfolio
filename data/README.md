# Data files

## `pois-toulouse.json`

Places of the Toulouse area used by the Rendez-vous page (`rendez-vous.html`): bars, restaurants,
shops, companies… with their addresses, and the Tisséo metro stations and bus stops. It is built from:

| Data | Source | Licence |
|---|---|---|
| Places and their own addresses | [OpenStreetMap](https://www.openstreetmap.org/copyright), Geofabrik's Midi-Pyrénées extract | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), © OpenStreetMap contributors |
| Metro stations, bus stops | [Tisséo GTFS](https://data.toulouse-metropole.fr/explore/dataset/tisseo-gtfs/), Toulouse Métropole open data | ODbL 1.0, © Tisséo |
| Addresses missing from OpenStreetMap | Base Adresse Nationale, through the [IGN Géoplateforme](https://geoservices.ign.fr/) | [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) |

The dates of each source are in the file's `sources` field. It is regenerated from scratch by
`scripts/regenerate-places.sh` (see `docs/location-pipeline.md` § 6).

**Licence**: as a database derived from ODbL data, `pois-toulouse.json` is made available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/), unlike the rest of
this repository, whose code is under the MIT licence (`LICENSE`).

## `tisseo-area.json`

The bounding box of the OpenStreetMap export (the Tisséo network's area), read by
`scripts/build-places.js` only.

## Thanks

This page would not exist without the people who map their streets on OpenStreetMap, publish
timetables as open data, maintain the national address base, and write and share the free software
and services it is built on, from routing engines to map libraries. To every one of them,
volunteers and professionals alike: thank you, warmly.
