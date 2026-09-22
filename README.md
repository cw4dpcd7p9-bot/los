# LOS

A real-world map with pause-map chrome.

Not Google. Not a game extract. OpenStreetMap data, a heading-up radar, one waypoint, a purple GPS ribbon you can read without squinting.

## Open it

Serve the folder (MapLibre will not like `file://` for workers in some browsers):

```bash
python3 -m http.server 8788
```

Then [http://127.0.0.1:8788](http://127.0.0.1:8788). Allow location.

## Why this is not another skin

Most map apps fail while you’re moving. Cards cover the road. Pins multiply. The next turn is a paragraph.

LOS keeps three numbers on the glass: **speed**, **ETA**, **distance**. The next maneuver is a billboard. The radar rotates with you. The pause map stays north-up so you can aim a point with a finger, like the old pause screen. Search is a command box. There is no recommended restaurant.

Tiles: [OpenFreeMap](https://openfreemap.org) (no key).  
Routes: [OSRM](https://project-osrm.org) public demo.  
Search / reverse: [Photon](https://photon.komoot.io).

Those public endpoints are for reasonable use. Don’t point a production fleet at them.

## Controls

- Click the map → set the only destination
- `YOU` → snap back to the blip
- `CAR` / `FT` → drive or walk
- `CLR` → drop the waypoint

## What this is not

It is not offline. It is not live traffic. It is not an iOS package — that’s the next cut, SwiftUI, same HUD. It does not ship Rockstar art. The language is the HUD language: radar, blip, pause map, one waypoint.
