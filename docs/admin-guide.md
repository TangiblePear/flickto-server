# Admin Guide — Curating Award Seasons

The admin app is a small Vite + React UI that runs on your machine only (`127.0.0.1:5173`). It searches TMDB for nominees, writes JSON files to `content/awards/`, and on Save it commits + pushes to git — Cloudflare Pages auto-rebuilds within ~30 seconds and the app picks up the new data on its next manifest refresh.

There is **no authentication**, by design. The only thing protecting your award data is that the server only listens on `127.0.0.1`. Anyone with shell access to your machine can edit content.

---

## 0. First-time setup (5 minutes)

You'll need:
- **Node.js** ≥ 18 — `node --version` to check
- **pnpm** — `npm install -g pnpm` if you don't have it
- **A TMDB API key** — the same one you use in the Flickd app (`local.properties` → `DEFAULT_TMDB_READ_TOKEN`)
- **Git** configured to push to your `flickto-server` GitHub repo (the launcher commits + pushes on every save)

That's it. No other dependencies.

---

## 1. Launch the app

Double-click **`start-admin.bat`** in `C:\Users\reser\Workspaces\Media Remote\flickto-server\`.

What happens:
1. The script `cd`s into `admin/`.
2. On first run only, it runs `pnpm install` (~1 minute, ~300 MB of `node_modules`).
3. On first run only, it copies `.env.example` to `.env.local` and opens it in Notepad. **Paste your TMDB key** next to `TMDB_API_KEY=`, save, close Notepad, then **re-run the .bat** to start the app.
4. On subsequent runs it just boots Vite + Express and opens your browser to `http://127.0.0.1:5173`.

The browser tab shows the admin UI.

> To stop the app, focus the terminal window and press `Ctrl+C`. Closing the browser tab does NOT stop the server.

> The `.env.local` file contains your TMDB key. It's gitignored — don't commit it.

### Optional: auto-push on save

By default the admin commits locally but doesn't push. If you want every save to also push to GitHub (which is what triggers Cloudflare Pages to rebuild), edit `admin/.env.local`:

```
GIT_AUTO_PUSH=true
GIT_REMOTE=origin
GIT_BRANCH=main
```

> Caveat: every save makes a commit. If you're iterating on a ceremony with 20 nominees, that's 20 commits. Either edit a season fully before saving, or leave `GIT_AUTO_PUSH=false` and push manually when you're done.

---

## 2. Create a new ceremony

1. Sidebar → **New ceremony**.
2. **Pick a template.** Click one of the six tiles (Oscars / Emmys / BAFTAs / Globes / NTAs / BET). The tile highlights orange when selected. Each template ships with the standard category list for that ceremony pre-filled.
3. **Set dates.**
   - **Year** — defaults to next year. Adjust if needed.
   - **Nominations announced** — start of the banner-visible window. Optional. Defaults to Jan 1 of that year.
   - **Ceremony date** — drives the "winners announced" banner state and the countdown. Optional.
4. Click **Create `<template>-<year>`**.

A JSON file is written to `content/awards/<template>-<year>.json` with all the standard categories but **zero nominees**. You're navigated to the edit page.

> The auto-generated `endDate` is ceremony + 30 days (banner-hide cutoff). Override by editing the JSON manually if you want a different archive window.

---

## 3. Add nominees

The edit page lists every category. For each:

### MEDIA categories (Best Picture, Best Animated Feature, etc.)

There's a single search box at the bottom of the category. Type a title → TMDB results appear → click one to add it as a nominee. The film's poster, type (movie/TV), and TMDB ID auto-fill.

To remove a nominee, click the × on its chip.

### PEOPLE categories (Best Actor, Best Director, etc.)

Two fields per addition:
1. **Person name** — type freely, e.g. "Cillian Murphy". This is what the UI displays.
2. **Film/show** — TMDB search for the title the nomination is *for*, e.g. Oppenheimer. Click the result.

When you click a film, the nominee is added linking the person name to that film. The text field clears so you can immediately type the next person's name and pick their film.

> Why two fields? TMDB's person search returns roles in a way that doesn't reliably match nominations to specific films. Typing the name is faster and accurate.

### Bulk-edit shortcut

If you need to bulk-edit, the JSON files are plain text at `content/awards/<slug>.json`. Edit them in your editor, save, then run `node scripts/build-manifest.mjs` from the repo root to refresh the manifest, then commit + push manually.

---

## 4. Save and push

Top-right of the edit page: **Save & push**.

- Writes the updated JSON to `content/awards/<slug>.json`.
- Regenerates `content/manifest.json` and `content/awards/index.json`.
- Runs `git add content/`, `git commit -m "admin: update <slug>"`.
- If `GIT_AUTO_PUSH=true` is set, also pushes.

You'll see a green banner: **"saved and committed"**.

Cloudflare Pages auto-rebuilds on push. The new JSON is live within ~30s. The Android app sees it on the next manifest revalidation (≤5 minutes for already-open sessions, or instantly on next cold start).

---

## 5. Mark winners on ceremony night

This is a separate flow so you don't accidentally toggle a winner while editing nominees.

1. From the awards list, click into a ceremony.
2. Top-right: **Mark winners →**.
3. For each category, click the nominee that won. The card border turns orange and a **★ WINNER** badge appears.
4. Only one winner per category — clicking another nominee swaps the winner.
5. Click an already-winning nominee to un-mark (in case of typo).
6. **Save & push** — same flow as edit page.

The Android app picks up winner changes on the same ≤5-min manifest TTL. If you want the change to land instantly during the live ceremony, you have two options:
- **Reduce the manifest cache TTL** in `content/feature-flags.json` (the `manifestCacheSeconds` field) temporarily.
- **Tell the app to force-refresh** — there's no UI for this yet, but you can ask testers to swipe-down or restart.

---

## 6. Edit an existing ceremony later

Sidebar → **Awards** → click the season tile. You're on the edit page with everything as you left it. Same workflow.

If you need to **delete a ceremony**, there's no UI for that. Delete the file:
```powershell
Remove-Item "C:\Users\reser\Workspaces\Media Remote\flickto-server\content\awards\<slug>.json"
node "C:\Users\reser\Workspaces\Media Remote\flickto-server\scripts\build-manifest.mjs"
git add content/
git commit -m "chore: remove <slug>"
git push
```

---

## 7. Add a new ceremony template

The six built-in templates are JSON files in `templates/`. Adding a new one is just dropping another JSON file with the same shape — the admin picks it up automatically on next start.

Example: `templates/screen-actors-guild.json`
```json
{
  "templateId": "sag",
  "displayName": "Screen Actors Guild Awards",
  "slugPrefix": "sag",
  "eventName": "SAG Awards",
  "categories": [
    { "name": "Outstanding Performance by a Cast in a Motion Picture", "kind": "MEDIA" },
    { "name": "Outstanding Performance by a Male Actor in a Leading Role", "kind": "PEOPLE" }
    // ...
  ]
}
```

Fields:
- `templateId` — unique short id. Used internally only.
- `displayName` — what shows on the template tile.
- `slugPrefix` — gets combined with the year to make the season slug (`sag-2026`).
- `eventName` — what gets written to the JSON `eventName` field.
- `categories` — array of `{ name, kind }` where `kind` is `"MEDIA"` (the nominee IS the film/show) or `"PEOPLE"` (the nominee is a person tied to a film/show).

No restart needed — refresh the admin in your browser.

---

## 8. Common issues

| Symptom | Fix |
|---|---|
| `start-admin.bat` says "pnpm not found" | `npm install -g pnpm` and re-run |
| Browser opens to a blank page | Wait ~5 seconds for Vite to finish booting; refresh |
| TMDB search returns nothing | Check `admin/.env.local` has `TMDB_API_KEY=...` (no quotes needed), restart the .bat |
| Save → red "git command failed" | The repo isn't connected to a remote, or your branch is behind. From the repo root, `git status` and `git pull --rebase` first |
| New ceremony slug clashes with existing | Bump the year, or delete the existing one first |
| Browser shows "Cannot connect to localhost:5174" on Save | Express side died; check the terminal window for an error and re-run the .bat |
| The admin still shows old data after I edited a JSON manually | Refresh the browser. The admin reads from disk on every page load |

---

## 9. Where files end up

- `content/awards/<slug>.json` — full season data (categories, nominees, winners)
- `content/awards/index.json` — auto-regenerated list of all seasons; **don't hand-edit**
- `content/manifest.json` — auto-regenerated; **don't hand-edit**
- `templates/*.json` — ceremony templates; hand-editable

Everything in `content/` is what Cloudflare Pages serves. Everything in `templates/` is admin-only and never reaches the app.
