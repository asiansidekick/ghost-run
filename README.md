# Street Legal

A mobile web app that logs your drives (route, speed, acceleration and braking) and lets you share them with friends by link. First build is set up for Bangkok.

- Open the site on your phone and add it to the home screen (iPhone: Share → Add to Home Screen).
- Tap **Start a drive** while parked, leave the page on screen, and hold **Stop** once parked again.
- Stretches over the speed limit show in red on the map and speed chart. Limits come from OpenStreetMap where roads are tagged, and Thai defaults elsewhere (80 km/h in greater Bangkok, 90 outside, 90 on untagged Bangkok expressways, 120 on motorways outside Bangkok). They're approximate.
- Sharing packs the drive into the link itself (after the `#`), so there is no server or account. A shared route opens with a map and turn-by-turn directions.

## How it's built

Plain HTML, CSS and JavaScript modules with no build step, so it can be hosted on GitHub Pages as is.

| Piece | Source |
| --- | --- |
| Map | Leaflet 1.9.4 (in `vendor/`), OpenStreetMap tiles |
| Speed limits | Overpass API (OpenStreetMap `maxspeed`), `js/limits.js` |
| Directions | Public OSRM server, map-matching, `js/directions.js` |
| Storage | IndexedDB on the phone, `js/store.js` |

All of these are free and need no API key. The public OSRM and Overpass servers are meant for light use, which suits a small group of friends.

## Running locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. GPS needs HTTPS on a phone, so test real drives on the hosted site.
