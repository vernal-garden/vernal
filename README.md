# Vernal

Open source garden planning for the gardener who's outgrown every app they've tried.

---

> **Status: active development.** No install yet. The commit history is the honest record of how it gets built.

---

## What it is

Serious home gardeners don't have a tool that keeps up with them. GrowVeg is the most mature option in the space, and if you stop paying, your history disappears with your subscription. Planter has the best mobile experience in the category and hits a ceiling fast. Nobody has built a real analytics layer. The apps will tell you where to plant the tomatoes. They won't tell you why bed three underperformed last year.

Vernal is that tool. Web-first, open source at its core, built for gardeners who keep records and want software that keeps up.

---

## Features

Planned, not shipped. This list will evolve as development turns up things worth adding or cuts things that don't hold up.

**Layout and planning**
- Grid-based and freeform drawing for non-rectangular beds, multiple garden styles
- Companion planting warnings on the canvas as you plan
- Season history overlay: toggle between years on the same layout

**Seed catalogue**
- Visual sleeve UI modeled on a physical seed binder
- Full data per entry: variety notes, germination info, source, personal ratings
- Tied into Cambium (see below) for community-contributed data

**Planting guide**
- Zone-aware timing with frost date integration
- Automatic spacing calculations by garden style and bed type
- Succession planting support

**Growth visualization**
- SVG illustrations tracking each plant from seed through harvest
- The canvas reflects the actual state of your garden as the season progresses

**Data layer**
- Cross-season yield comparisons by bed and plant
- Soil amendment tracking per bed, over time
- Fertilizer records tied to harvest data
- Photo journaling per bed and plant

**Integrations**
- Tempest/WeatherFlow personal weather station support (paid tier)
- CSV export. Your data works outside Vernal, and always will.

---

## The open core

The core is open source and free. Not a limited demo. A complete, functional app. You can run it, fork it, self-host it. The paid tier covers features that cost real infrastructure: cloud sync, weather station integration, and the deeper analytics layer.

**Free**
- Unlimited gardens, full layout tools including freeform drawing
- Complete seed catalogue with the full visual UI
- Planting guide with zone-aware timing and spacing
- Growth visualization
- Season history
- Community seed database access (read and contribute)
- CSV export

**Paid**
- Cloud sync and multi-device access
- Personal weather station integration
- Advanced analytics and cross-season comparisons
- Soil chemistry tracking over time
- Fertilizer records and suggestions
- Crop rotation algorithm with placement warnings
- Photo journaling with storage
- PDF export

**Supporter tier**
No extra features. Just a way for free users who love the app to back it financially. It'll appear at moments that make sense, not as a persistent nag.

---

## Cambium

Cambium is a community-contributed seed and plant database being built inside Vernal, with a clean internal API separation from the start. Once it has enough depth, it'll be extracted and released as a standalone public API at cambium.garden.

OpenFarm shut down in April 2025. Nothing has replaced it. Cambium is being built to fill that gap: open to any developer building gardening tools, free for individuals and open source projects, with a commercial tier for apps building on top of it.

The Cambium repo will live at [github.com/vernal-garden/cambium](https://github.com/vernal-garden/cambium) once it's split out.

---

## Current status

Development is underway. The commit history is the honest record of how this gets built. The devlog at [vernal.garden](https://vernal.garden) covers the decisions and tradeoffs along the way.

---

## Tech

- Web-first PWA, installable from the browser, works offline
- Android via TWA/Capacitor when ready; iOS after that
- Frontend: React
- Canvas: Konva.js
- Backend: Node.js + Express + TypeScript
- Database: PostgreSQL (Neon)
- Hosting: DigitalOcean

---

## Contributing

At this stage, the most useful contributions aren't code.

**Feedback on the product direction.** If something in the spec seems wrong, missing, or over-engineered, open an Issue. Early decisions are cheap to change.

**Plant and seed data.** The seed database needs breadth. Contributing variety data, growing notes, and regional timing information is genuinely useful right now.

**SVG plant illustrations.** The growth visualization system needs illustrated growth stages for a long plant list. The style guide is at [vernal.garden/illustrations](https://vernal.garden/illustrations).

Code contributions will open up once there's something to contribute to. See CONTRIBUTING.md.

---

## License

AGPL-3.0. The open-source core is free to use, modify, and self-host. If you run a modified version as a network service, your modifications must be made available to users of that service.

Commercial licenses are available for organizations requiring use without AGPL obligations. Contact [hello@vernal.garden](mailto:hello@vernal.garden).

---

Built by a solo developer who got tired of keeping garden notes in a spreadsheet. If that sounds familiar, this is for you.