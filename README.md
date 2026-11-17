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

If Spotify cannot find a track, the file is still tagged — it just gets no cover art.

## Development

```sh
npm install
npm run dev        # development server on http://localhost:5173
npm test           # unit tests (vitest)
npm run typecheck  # typescript
npm run build      # production build into dist/
npm run preview    # serve the production build
```

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
| Track numbers in the descriptor | the first broken line aborted the whole run | every problem of the file is reported at once |
| `TRK` frame | mutagen silently dropped it (a frame id needs four characters) | not written, `TRCK` is used |
| Comment language | `XXX` (mutagen placeholder) | `eng` |
| Duration of a file | mutagen | own MP3 parser, verified against mutagen on real files |
| Existing ID3v2 frames of a file | kept, except `COMM` and `TXXX` | kept the same way |
| ID3v1 tag at the end of the file | kept (with outdated values) | removed, it would contradict the new tags |
| File without an ID3v2 tag | skipped, mutagen refuses to read it | tagged anyway |
| Files in sub folders | ignored (`os.listdir` only reads the top level) | ignored as well, but they are listed as a warning |
| Output | files renamed in place | files are downloaded as a ZIP, the browser cannot write to your disk |
| Spotify credentials | config file / env / CLI | entered in the app, optionally remembered in local storage |

The ID3 layout itself is byte compatible with the Python tool: ID3v2.4, UTF-16 text frames,
`TIT2`, `TPE1`, `TPE2`, `TALB`, `TCON`, `TCOM`, `TRCK`, `COMM` and `APIC`.

## License

MIT — like the original [AutoDITag](https://github.com/klassenserver7b/AutoDITag) project.
