# Hit on the Way

A private family music guessing game for the car. The full plan is in the project's planning doc.

## Step 0: car test (`index.html`)

A single page with no server. It signs in to Spotify, plays random songs from one of your playlists, and shows only play/pause, so you can check whether the song title leaks on the car screen or the iPhone lock screen.

### Setup

1. Go to the Spotify developer dashboard and create an app.
   - Tick **Web API** and **Web Playback SDK**.
   - Add the redirect URI where this page is hosted, for example `https://alonabel13-stack.github.io/Hit-on-the-way/` (with the trailing slash).
2. Copy the app's **Client ID**. No client secret is needed: the page uses PKCE sign-in.
3. Host this page on HTTPS (GitHub Pages: Settings → Pages → deploy from `main`, root folder).
4. Open the page on the iPhone, paste the Client ID, sign in, pick a playlist.

### What to test

- **Spotify app** mode: the Spotify app plays in the background, controlled from this page.
- **This browser** mode: Safari plays the audio itself.
- For each mode, check the car screen, the lock screen, and whether next/pause still work after 5 minutes paused.

This app is for personal use only and must not be published, per Spotify's developer policy.
