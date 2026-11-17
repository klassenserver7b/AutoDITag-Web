# AutoDITag Web

A browser-only port of [AutoDITag](https://github.com/klassenserver7b/AutoDITag) — the tool that
renames and tags the mp3 files of a dance playlist and creates the matching `.m3u` playlist files.

This version runs **entirely in the browser**: there is no server, no upload and no account.
The music files never leave your machine.

- Renames `01-Song.mp3` to `01_Title; Artist -- Dance.mp3`
- Writes the ID3 tags (title, artist, album, genre/comment, track number, cover art)
- Creates `<Playlist>.m3u` and `<Playlist>.m3u8`
- Optionally fetches the album art from Spotify with **your own** client id and client secret
- Bundles everything into a single ZIP you can download

Static files, no backend — perfect for GitHub Pages.

**Live:** <https://klassenserver7b.github.io/AutoDITag-Web/> ·
**Repository:** <https://github.com/klassenserver7b/AutoDITag-Web>

## Usage

1. **Pick the folder** with your mp3 files (or drag & drop it onto the page).
2. **Load the descriptor file** that lists the playlist — upload the `.txt` or paste its content.
   Every line has the format `TRACKNUM_TITLE; ARTIST -- DANCE`:

   ```
   01_Voices of Spring; André Rieu -- Wiener Walzer
   02_Shut Up And Dance; Walk The Moon -- Discofox
   ```

3. **Name the playlist**, for example `Schulball 08.05.2024`.
4. Optionally switch on **Spotify cover art** (see below).
5. Press **Run** and download the ZIP. It contains the renamed and tagged mp3 files plus the
   two playlist files.

The preview table shows what will happen to every file before you start, including tracks
without a matching file.

The files are read in the browser and written into a ZIP that is held in memory, so very large
folders (more than a few hundred megabytes) can use a lot of RAM.

## Spotify album art (optional)

The app talks to the Spotify Web API directly from the browser, so it needs credentials of a
Spotify app that **you** own:

1. Open <https://developer.spotify.com/dashboard> and create an app
   (redirect URI `http://localhost` is enough, it is not used).
2. Copy the **client id** and the **client secret** from the app settings.
3. Paste both into the Spotify section of the app and switch the feature on.

The credentials are only sent to Spotify. They are kept in the browser's local storage only if
you tick "remember in this browser" — otherwise they are discarded when you reload the page.
Since a client secret cannot be hidden in a browser app, every user should use their own app.

> On GitHub Pages every page of a user shares the same origin (`<user>.github.io`), and the
> browser stores local storage unencrypted on disk. If that matters to you, do not tick
> "remember in this browser" — the secret then only lives in the open tab.

If Spotify cannot find a track, the file is still tagged — it just gets no cover art.

## Development

```sh
npm install
npm run dev        # development server on http://localhost:5173
npm test           # unit tests (vitest)
npm run typecheck  # typescript
npm run build      # production build into dist/
npm run preview    # serve the production build
npm run e2e        # end to end test in a real Firefox (needs: npx playwright install firefox)
npm run a11y       # accessibility smoke test in a real Firefox
```

The end to end test (`scripts/e2e.mjs`) serves the production build from a sub directory — like
GitHub Pages does — picks a folder of mp3 files in Firefox, runs the job, downloads the ZIP and
checks the result. The Spotify flow is tested with a mocked API, so the embedded cover art is
verified as well. `scripts/verify_output.py` reads the downloaded files back with mutagen, the
same library the original Python tool uses.

### Project layout

```
src/core/       pure logic, no DOM - this is where the porting work happened
  descriptor.ts   parses and validates the descriptor file
  filename.ts     file name conventions
  plan.ts         matches descriptor entries to the selected files
  mp3.ts          reads the duration and strips existing tags
  id3.ts          writes and reads ID3v2 tags
  playlist.ts     builds the .m3u / .m3u8 files
  spotify.ts      Spotify client credentials flow, cover art lookup
  process.ts      the pipeline: rename -> tag -> playlist
  picker.ts       folder / file selection (Firefox compatible)
  zip.ts          builds the download archive
src/main.ts     the controller that wires the UI to the core
tests/          unit tests (vitest)
```

## Deployment on GitHub Pages

The repository contains a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds
the app and publishes it to GitHub Pages. Enable *Settings → Pages → Source: GitHub Actions* and
push to `main`.

All asset paths are relative, so the app also works from any sub-path
(`https://<user>.github.io/<repo>/`) and from a plain file server.

## Browser support

Developed and tested with **Firefox**. The app deliberately avoids the File System Access API
(which Firefox does not implement) and uses `<input type="file" webkitdirectory>` plus drag &
drop instead. Chromium based browsers work as well.

## Differences to the Python tool

The port keeps the behaviour of `auto_di_tag.py` but fixes a few rough edges:

| Topic | Python tool | This app |
| --- | --- | --- |
| Playlist with less than ten tracks | renames with a two digit prefix, so `1_Song.mp3` was not found | zero padded and unpadded names are both accepted |
| Track numbers in the descriptor | the first broken line aborted the whole run | every problem of the file is reported at once, but nothing is processed while there is one |
| `TRK` frame | mutagen silently dropped it (a frame id needs four characters) | not written, `TRCK` is used |
| Comment language | `XXX` (mutagen placeholder) | `eng` |
| Duration of a file | mutagen | own MP3 parser, verified against mutagen on real files |
| Existing ID3v2 frames of a file | kept, except `COMM` and `TXXX` | kept the same way |
| ID3v1 tag at the end of the file | updated from the ID3v2 frames when it exists, never created | removed, it would contradict the new tags |
| File without an ID3v2 tag | skipped, mutagen refuses to read it | tagged anyway |
| File with a broken ID3v2 tag | skipped, mutagen refuses to read it | the music is searched and kept, the file is only skipped when it has no audio at all |
| Frames of an ID3v2.2 tag | mutagen upgrades them (`TT2` becomes `TIT2`) | not read, only the frames of the tool are written |
| Files in sub folders | ignored (`os.listdir` only reads the top level) | ignored as well, but they are listed as a warning |
| File extension | only `.mp3` (case sensitive) | `.mp3` and `.MP3` are both used |
| Output | files renamed in place | files are downloaded as a ZIP, the browser cannot write to your disk |
| A run without any processed file | produces an empty result | reported as an error, no download is offered |
| Spotify credentials | config file / env / CLI | entered in the app, optionally remembered in local storage |

The ID3 layout is ID3v2.4 with UTF-16 text frames: `TIT2`, `TPE1`, `TPE2`, `TALB`, `TCON`,
`TCOM`, `TRCK`, `COMM` and `APIC`. The frame data is byte for byte identical to the one mutagen
writes — only the order of the frames, the language of the comment (`eng` instead of `XXX`) and
the padding differ (mutagen pads the tag, the web app writes it without padding).

## License

MIT — like the original [AutoDITag](https://github.com/klassenserver7b/AutoDITag) project.
