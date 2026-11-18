# kixy-node

A Node.js and TypeScript API for short-form content, backed by PostgreSQL 16:

- **Clip finder.** Send the transcript of a long video (timed words, SRT or WebVTT) and get back the
  moments that work as vertical clips: start and end times, a title, an on-screen hook, a score and the
  reason it was picked. Each clip comes with burn-in captions (an ASS subtitle file in one of four
  styles) and a render plan: the time range, the 9:16 crop window for the source frame, the
  720x1280 output size and the caption file. Clips can be trimmed, retitled and recaptioned afterwards.
- **Images** from a prompt in one of twelve styles.
- **Coloring books**: black-and-white pages, a printable PDF and a ZIP of everything.
- **Storyboards**: a short script split into scenes, a picture for each scene and, with a voice
  provider, narration audio per scene.

It also has accounts, a credit balance with a ledger, and a job queue in Postgres: work runs in
the background, is charged when it is queued, is refunded if it fails, and picks up again after a
restart.

This service does not decode or encode video. It does the planning; cutting and encoding the clips is
left to a renderer, which can read each clip's `render` plan from the API or run as another job kind
in the queue (see `src/handlers.ts`).

## Requirements

- Node.js 22.12 or newer and npm
- PostgreSQL 16 (the server programs, for local development and tests)

No other system packages, network access or API keys are needed to build, test or run it.

## Quick start

```sh
npm install
npm run build
npm test
```

`npm test` builds the project, starts a throwaway PostgreSQL cluster with the PostgreSQL server
programs on the machine (from `PG_BIN`, `pg_config` or `/usr/lib/postgresql/16/bin`) on a free
port, runs every test, then stops and deletes the cluster. To use a server you already have
instead, set `TEST_DATABASE_URL` to a connection URL for a user that can create databases; each
test file creates its own database and drops it afterwards. When run as root, the temporary cluster
runs as the `postgres` system user, since PostgreSQL refuses to run as root.

## Running the server

1. Start PostgreSQL. Use the system service, or for development:

   ```sh
   npm run db:local        # creates and starts a cluster on 127.0.0.1:5432 (PGPORT to change)
   ```

   It keeps its data in `.pgdata` (or `/var/tmp/kixy-pgdata` when run as root; set `PGDATA_DIR`
   to choose). `npm run db:local:stop` stops it.

2. Create the database and apply the migrations:

   ```sh
   export DATABASE_URL=postgres://postgres@127.0.0.1:5432/kixy
   npm run db:setup
   ```

   This creates the database if it is missing and applies the SQL files in `migrations/` that have
   not run yet. The server also applies pending migrations when it starts.

3. Start the API:

   ```sh
   export JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
   npm start
   ```

All settings are environment variables; `.env.example` lists them with their defaults.

## Providers

| What | Without a key | With a key |
| --- | --- | --- |
| Clip picking, scripts, coloring page ideas | Built-in heuristics | Claude (`ANTHROPIC_API_KEY`) or an OpenAI-compatible chat API (`OPENAI_API_KEY`, `OPENAI_BASE_URL`) |
| Images | SVG placeholder cards; coloring pages drawn locally | OpenAI-compatible images API |
| Narration | None | OpenAI-compatible speech API |

If a model call fails, the job falls back to the built-in behaviour and says so in its `notes`.

## API

Everything is under `/api` and speaks JSON. Signed-in routes take `Authorization: Bearer <token>`
(file links also accept `?token=`). Errors look like `{ "error": "bad_request", "message": "..." }`;
running out of credits is a `402` with `need` and `have`.

| Method and path | What it does |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /config` | Providers in use, styles, caption styles, crop modes, prices, sign-up credits |
| `POST /auth/register` | `{ email, password }` (8+ characters) → `{ token, user }` |
| `POST /auth/login` | `{ email, password }` → `{ token, user }` |
| `GET /me` | The signed-in user and their credits |
| `GET /credits/ledger` | The latest 200 credit changes |
| `POST /credits/demo-topup` | Adds 50 credits (turn off with `ALLOW_DEMO_TOPUP=false`) |
| `POST /clipper` | Find clips. See below. |
| `POST /images` | `{ prompt, count 1-4, style, aspect: portrait \| square \| landscape }` |
| `POST /coloring` | `{ theme, pages 1-30, audience: kids \| adults, title }` |
| `POST /storyboard` | `{ prompt, duration 5-30 seconds, style, voice: true }` |
| `GET /jobs?kind=` | Your latest 100 jobs, with a thumbnail file when there is one |
| `GET /jobs/:id` | A job with its status, progress, output, clips and files |
| `DELETE /jobs/:id` | Delete a job and its files (not while it runs) |
| `GET /jobs/:id/transcript` | The clip job's transcript as timed words |
| `GET /jobs/:id/files/:name` | A job file; supports `Range`, and `?download=1` for an attachment |
| `GET /clips/:id` | One clip |
| `PATCH /clips/:id` | Edit `title`, `hook`, `start`, `end`, `crop_mode`, `crop_x`, `caption_style`, `show_hook` or `words` |

Every `POST` that starts work answers `{ "job_id": "..." }`; poll `GET /jobs/:id` until `status` is
`done` or `failed`.

### Finding clips

```json
POST /api/clipper
{
  "name": "episode-12.mp4",
  "transcript": "1\n00:00:01,000 --> 00:00:04,200\nNobody tells you this...\n",
  "format": "srt",
  "duration": 1820,
  "loudness": [0.12, 0.3, 0.28],
  "source": { "width": 1920, "height": 1080 },
  "options": { "count": 10, "min_len": 15, "max_len": 60, "caption_style": "bold", "crop_mode": "auto", "show_hook": true }
}
```

- `transcript` is required unless `loudness` is given. It is an array of `{ start, end, text }` (or
  `word`) in seconds, or SRT or WebVTT text. `format` (`words`, `srt`, `vtt`) is detected when left out.
- `loudness` is optional: one non-negative number per second of audio. It nudges the built-in picker
  towards lively moments, and lets it pick clips when there is no transcript.
- `duration` defaults to the end of the transcript or the loudness track.
- `source` is optional; with it, each clip's render plan includes the crop window.
- Caption styles: `bold` (word-by-word highlight), `clean`, `karaoke`, `none`. Crop modes: `auto`
  (follows `crop_x`), `center`, `fit`.

A clip in the job's `clips` looks like this:

```json
{
  "id": "…", "idx": 1, "title": "The money mistake", "hook": "Stop waiting", "score": 82,
  "reason": "Opens with a bold claim.", "start": 61.4, "end": 98.2, "duration": 36.8,
  "caption_style": "bold", "crop_mode": "auto", "crop_x": 0.5, "show_hook": true,
  "words": [{ "start": 61.5, "end": 61.8, "text": "Nobody" }],
  "captions": "clip_1_v1.ass", "version": 1,
  "render": {
    "source": "episode-12.mp4", "start": 61.4, "end": 98.2,
    "output": { "width": 720, "height": 1280, "fps": 30 },
    "framing": { "kind": "crop", "x": 657, "y": 0, "width": 606, "height": 1080 },
    "captions": "clip_1_v1.ass"
  }
}
```

Edits that change what the captions show (trim, hook, caption style, words) write a new caption
file and bump `version`.

### Prices

One credit per started minute of source video for the clip finder, one per image, one per coloring
page and five per storyboard. New accounts get `SIGNUP_CREDITS` (60 by default).

## Project layout

```
migrations/      SQL migrations, applied in order
scripts/         local PostgreSQL and the test runner
src/main.ts      server start-up
src/app.ts       Express app, routes and error handling
src/routes/      HTTP handlers
src/jobs.ts      the job queue
src/handlers.ts  the job kinds
src/pipelines/   clip finder, images, coloring books, storyboards
src/ai/          language model, image and voice providers; clip picking
src/media/       transcripts, captions, framing, PNG, PDF and ZIP writers
test/            tests (node:test)
```
