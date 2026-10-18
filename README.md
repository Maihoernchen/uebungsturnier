# Matline

Matline is an installable web app and Express API for amateur wrestling tournaments. It uses TypeScript, Vite, Express, and SQLite; the bundled `simplescoreboard` submodule remains unchanged.

## Run locally

Use Node.js 20 or newer:

```sh
npm install
npm run dev
```

Open the Vite address shown in the terminal. The API runs on port 3000 and the dev server proxies `/api` and `/scoreboard` to it. The SQLite database (`tournament.sqlite`) is created on first launch.

Build the PWA with `npm run build`, then set `SESSION_SECRET` to a random value of at least 32 characters and run `npm start` to serve the built app and API from port 3000. Serve production over HTTPS to enable PWA installation and service workers.

## First-run flow

1. Create a **Tournament provider** profile and create a tournament.
2. Athletes create profiles and join a tournament from the tournament list.
3. Coaches register their club name; athletes can choose the same registered club name. Tournament providers grant coach and referee access using the profile ID shown in each user's header.
4. Athletes send challenges for the active round. The challenged athlete accepts; an accepted challenge becomes a match.
5. Providers set the active round and reorder its queued matches. Permitted coaches can veto a queued match involving an athlete from their club.
6. Permitted referees start a match, operate the embedded scoreboard, and record a winner and win reason. Score and elapsed-time changes are saved while the bout is in progress and tournament views refresh during live bouts.

## Current MVP boundaries

- Each login is a single profile type. Create a separate account for each role.
- The provider controls one active round number. Round-robin, weight-class, and bracket generation are not implemented.
- Athlete club affiliation uses the registered club name; club membership approval and tournament invitation links are not implemented.
- The app shell can be installed and cached. Tournament actions require a live connection; offline write synchronization is not implemented.
- Provider profiles can currently be self-registered. A production deployment should replace open provider registration with administrator-issued invitations or equivalent onboarding.
