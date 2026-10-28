#!/usr/bin/env bash
# regenerate-places.sh - Rebuild data/pois-toulouse.json from scratch, for anyone who clones the
# repository (not deployed: scripts/ is in .vercelignore):
#   1. download the Geofabrik Midi-Pyrénées OpenStreetMap extract (~360 MB);
#   2. osmium: keep the Tisséo area (data/tisseo-area.json), then the amenity / office / shop /
#      craft features, exported as GeoJSON with their OSM ids;
#   3. scripts/build-places.js: categories, duplicate merging, Tisséo GTFS stops, addresses
#      (IGN Géoplateforme bulk reverse geocoder) and their normalization, then writes the file.
# Rules and fields: docs/location-pipeline.md § 6.
#
# Needs: curl, osmium (osmium-tool), node >= 18, unzip. Network: Geofabrik, Tisséo open data,
# IGN Géoplateforme (~4 bulk calls and ~200 single calls).
#
# Usage: scripts/regenerate-places.sh [--pbf <extract.osm.pbf>] [--work-dir <dir>]
#   --pbf       use an extract already downloaded instead of downloading it
#   --work-dir  where the intermediate files go (default: a new temporary directory, removed
#               at the end; a given directory is kept)

set -euo pipefail

EXTRACT_URL='https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf'
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pbf=''
work_dir=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pbf)      pbf="$(realpath "$2")"; shift 2 ;;
        --work-dir) work_dir="$2"; shift 2 ;;
        -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    esac
done

for tool in curl osmium node unzip; do
    command -v "$tool" > /dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done

if [[ -z "$work_dir" ]]; then
    work_dir="$(mktemp -d)"
    trap 'rm -rf "$work_dir"' EXIT
else
    mkdir -p "$work_dir"
fi
cd "$work_dir"

if [[ -z "$pbf" ]]; then
    echo "Downloading $EXTRACT_URL"
    curl -fL --progress-bar -o extract.osm.pbf "$EXTRACT_URL"
    pbf="$work_dir/extract.osm.pbf"
fi

# Date of the OSM data in the extract (YYYY-MM-DD), recorded in the output's sources
osm_date="$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" | cut -c1-10)"
if [[ ! "$osm_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "No replication timestamp in $pbf" >&2
    exit 1
fi
echo "OSM data of $osm_date"

bbox="$(node -p "const a = require('$REPO_DIR/data/tisseo-area.json'); [a.minLon, a.minLat, a.maxLon, a.maxLat].join(',')")"
echo "Extracting the Tisséo area ($bbox)"
osmium extract --overwrite -b "$bbox" "$pbf" -o area.osm.pbf
osmium tags-filter --overwrite area.osm.pbf nwr/amenity nwr/office nwr/shop nwr/craft -o tagged.osm.pbf
osmium export --overwrite tagged.osm.pbf -f geojsonseq -u type_id --geometry-types=point,polygon -o tagged.geojsonseq

node "$REPO_DIR/scripts/build-places.js" tagged.geojsonseq "$osm_date"
