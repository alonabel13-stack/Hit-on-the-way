# Hit on the Way

A private family music guessing game for the car. One phone (the host) is connected to the car and plays songs from Spotify without showing them. Everyone else guesses the year, song, artist and album on their own phone. The driver says their answers out loud and the host types them in.

**Scoring:** exact year 2 points, within 2 years 1 point; song, artist and album 1 point each. Small typos are accepted, Hebrew and English spellings both count, and the host can fix close calls on the reveal.

This app is for personal use only and must not be published, per Spotify's developer policy.

## How it's built

- `index.html`, `css/`, `js/`: a static web app with no build step, served by GitHub Pages.
- `supabase/schema.sql`: the database (Supabase, free tier). All game rules and scoring run in the database, so the answer never reaches a player's phone before the reveal.
- Spotify plays on the host phone through the Spotify Web API (Premium needed).
- Original release years come from MusicBrainz.

## One-time setup

1. **Database.** Create a free project at [supabase.com](https://supabase.com). Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.
2. **Connect it.** In Supabase, open **Project Settings → API keys** and copy the **Project URL** and the **anon / publishable key**. Put them in `js/config.js`. Both are safe to publish: the key only lets people call the game's functions.
3. **Spotify.** In the Spotify developer dashboard, the app's redirect URI must be exactly the address you open the game at, for example `https://alonabel13-stack.github.io/Hit-on-the-way/`.
4. **Hosting.** GitHub Pages, deploying from `main`, root folder.

Supabase pauses free projects after a week without use. If the game says it can't connect, open the Supabase dashboard and restore the project.

## Before the first game (on the host phone)

1. Open the game, tap **Song library**, and choose a passphrase. The first passphrase entered becomes the library passphrase.
2. Sign in to Spotify and **Add** your playlists.
3. Tap **Check original years** and leave it running (about one song a second).
4. Optional: open a playlist's **Songs** to fix years, add other spellings (Hebrew or English names), or hide songs.

## Playing

1. Host: **Host a game**, pick playlists and the number of songs, **Create game**.
2. Passengers scan the QR code (or open the site and type the code) and enter their names.
3. Host adds the driver by name, then **Start the first song**.
4. Keep the host phone unlocked during the game. A locked iPhone shows the song on the lock screen.
