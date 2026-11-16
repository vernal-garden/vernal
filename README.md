# Vernal™

Garden planning that remembers what happened.

> **Status:** in active development. A small private beta starts December 1 and runs to the end of January. Applications are open at [vernal.garden/beta](https://vernal.garden/beta) through December 31.

---

## What it is

Vernal™ is a garden planning app that runs in your browser. Lay out your beds, keep your seed catalogue, time plantings to your frost dates and log what you harvest. Every season stays on record, so when a bed underperforms you can look back and find out why instead of guessing.

It installs from your browser on desktop and phone. Planning beds is desktop work. A phone works fine for logging things while you're out in the garden.

Vernal™ is open source and free to use, with a paid plan for extra tools. Every line of code is in this repo under AGPL-3.0, paid features included.

---

## Features

**Free, for every account**
- Unlimited gardens, with grid and freeform beds
- Seed catalogue with the visual sleeve UI, including seeds you add by hand
- Planting guide with zone and frost-date timing
- Spacing worked out on the canvas as you place plants
- Growth stages on the canvas for every planting, with illustrated stages arriving plant by plant
- Season history, with an overlay that lays a past season over the current one
- Companion planting warnings on the canvas
- Cambium™, Vernal™'s community seed database: search it and add to it
- Sync across every device you sign in on
- A full export of your data, as a ZIP of JSON files

**Paid, with the Supporter plan**
- Local weather, plus personal weather station integration (Tempest/WeatherFlow)
- Advanced analytics, including season-to-season comparison
- Soil chemistry tracking and an amendment (fertilizer) log
- Photo journaling
- Printable harvest log (save it as a PDF from your browser)

A Supporter pays for the paid tools on vernal.garden and the storage and weather connections they run on. The code is public; on vernal.garden, Robert runs it for you. Every account gets standard support.

---

## Cambium™

Cambium™ is the shared pool of seeds every Vernal™ gardener draws from and adds to. It's built inside Vernal™. It's small today, and it grows as gardeners add the varieties they actually grow.

---

## Tech

- Progressive Web App. Installable from your browser on desktop and phone. Needs a connection to load and save your garden.
- Frontend: React 18, with Konva.js for the canvas
- Backend: Node.js, Express and TypeScript
- Database: PostgreSQL. vernal.garden uses Neon; a self-hosted copy runs on any PostgreSQL.
- Hosting: vernal.garden runs on DigitalOcean

---

## Run it yourself

You can run your own copy of Vernal™. Payments, email, Google sign-in and cloud storage are all optional; PostgreSQL is the only service it needs.

**You'll need:** Node.js 24 or newer, PostgreSQL, and a web server that can serve static files and forward requests (nginx, Caddy or similar). Use HTTPS for a site on the internet.

**1. Install the server's dependencies.**

```
git clone https://github.com/vernal-garden/vernal.git
cd vernal
npm ci
```

**2. Create a database and a user that owns it.**

```
psql -U postgres -c "CREATE ROLE vernal LOGIN PASSWORD 'choose-a-password';"
psql -U postgres -c "CREATE DATABASE vernal OWNER vernal;"
```

The first migration turns on PostgreSQL's `pgcrypto` extension, which the database owner can do without superuser rights.

**3. Configure the server.** Copy `.env.example` to `.env`, then set:

- `NODE_ENV=production`. The example file says `development`, which is only for running on your own machine.
- `DATABASE_URL`, for example `postgres://vernal:choose-a-password@localhost:5432/vernal`, and `DATABASE_SSL=false` if your PostgreSQL doesn't use SSL.
- `SESSION_SECRET` and `ENCRYPTION_KEY`. The comments in `.env.example` give the command to generate each one.
- `FRONTEND_URL` and `APP_URL`: your site's address, such as `https://garden.example.com`. With an `https://` address, sign-in cookies are secure. A plain `http://` address works on a home network, without HTTPS.
- **Payments:**
  - `BILLING=off` runs without payments, and every account gets every feature.
  - To take payments, leave it as `stripe` and set your Stripe settings.
- **Email:**
  - `MAIL_MODE=off` runs without a mail server. Password resets and email changes aren't available then. Use `npm run account` instead (below).
  - To send email, leave it as `smtp` and set the `SMTP_*` settings.
- **Photos and exports:**
  - `MEDIA_STORAGE=local`, with `MEDIA_DIR` set to an absolute folder path, keeps them on the server's own disk.
  - To keep them in Cloudflare R2 or another S3-compatible store, use `s3` and set the `R2_*` settings, plus `S3_ENDPOINT` for a store other than R2.
- **Optional:**
  - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` turn on Google sign-in.
  - `VISUAL_CROSSING_API_KEY` turns on local weather (a Supporter tool).
  - Leave them blank to go without.

When the server starts, it prints one line showing what's on, for example `[config] billing=off mail=off media=local google=off weather=off`. If a setting is missing or wrong, it stops and tells you which one.

**4. Create the tables and load the starter plant data.**

```
npm run migrate
npm run seed:cambium
```

Both are safe to run again: migrate skips what's already applied, and the seed skips plants that already exist.

**5. Build and start the server.**

```
npm run build
npm start
```

It listens on port 3000, or whatever you set as `PORT`.

**Managing accounts without email.** With `MAIL_MODE=off`, these commands do what the email links would:

```
npm run account -- set-password you@example.com
npm run account -- set-email you@example.com new@example.com
npm run account -- set-role you@example.com admin
```

`set-role … admin` opens the Admin screens for your account.

**6. Build the app.** The app's settings file, `client/.env.production`, is committed with blank values, so a fresh copy doesn't point at vernal.garden. Put your own values in `client/.env.production.local`, which git ignores:

- `VITE_API_BASE_URL`: leave it blank when the app and the API share an address, as in step 7.
- `VITE_SENTRY_DSN`: leave it blank to turn error reporting off.
- `VITE_SENTRY_ENVIRONMENT`: an optional label for your Sentry reports.

Then build it:

```
cd client
npm ci
npm run build
```

Install the server's dependencies (step 1) first, because the app build generates its license notices from them.

**7. Put a web server in front.** Serve `client/dist` as your site, sending unknown paths to `index.html`, and forward `/api` and `/health` to `http://localhost:3000`. Use HTTPS if the site is on the internet; a home-network server can run on plain `http://`. Vernal™ expects exactly one proxy in front of it.

**8. Check it.** `https://your-address/health` should return `"status":"ok"` and `"db":"ok"`.

---

## Contributing

I'm building Vernal™ by myself, and right now the most useful help isn't code.

**If you garden,** apply for the beta at [vernal.garden/beta](https://vernal.garden/beta). It's around 40 people planning a real garden for the coming season and telling me what's broken, confusing or missing. That's about 15 minutes a week.

**If you build software,** read the code, and open an [Issue](https://github.com/vernal-garden/vernal/issues) when something in the product direction looks wrong or when you have seed data to share. A bad call is cheapest to fix before it ships.

I'm not taking pull requests yet. That opens once a contributor agreement is in place, and this README will say so when it does.

---

## License

Vernal™ is licensed under AGPL-3.0. If your organization needs different terms, for example to run a modified Vernal™ without publishing your changes, email hello@vernal.garden.

The AGPL-3.0 license covers the code. It doesn't cover the Vernal™ and Cambium™ names, logo or app icon.

---

Built by a solo developer who got tired of keeping garden notes in a spreadsheet. If that sounds familiar, this is for you.
