#!/usr/bin/env python3
"""Verify the output of the web app with mutagen.

Reads the zip archive the browser produced and checks that the ID3 tags and
the playlist files contain the expected values. This is the same library the
original Python tool used, so it proves the port writes compatible files.

Usage: python3 scripts/verify_output.py [archive.zip]
"""
import sys
import zipfile
from pathlib import Path

from mutagen.id3 import ID3
from mutagen.mp3 import MP3

EXPECTED = {
    "01_Voices of Spring; André Rieu -- Wiener Walzer.mp3": {
        "TIT2": "Voices of Spring",
        "TPE1": "André Rieu",
        "TCOM": "André Rieu",
        "TCON": "Wiener Walzer",
        "COMM": "Wiener Walzer",
        "TALB": "E2E Playlist",
        "TPE2": "E2E Playlist",
        "TRCK": "01",
    },
    "02_Shut Up And Dance; Walk The Moon -- Discofox.mp3": {
        "TIT2": "Shut Up And Dance",
        "TPE1": "Walk The Moon",
        "TCON": "Discofox",
        "COMM": "Discofox",
        "TALB": "E2E Playlist",
        "TRCK": "02",
    },
    "03_Friday I'm In Love; The Cure -- Cha Cha Cha.mp3": {
        "TIT2": "Friday I'm In Love",
        "TPE1": "The Cure",
        "TCON": "Cha Cha Cha",
        "COMM": "Cha Cha Cha",
        "TALB": "E2E Playlist",
        "TRCK": "03",
    },
}


def verify_cover_archive(archive: Path, failures: list) -> None:
    """The archive of the spotify run has to contain the embedded cover art."""
    if not archive.exists():
        print(f"\n(skip: {archive} does not exist)")
        return
    print(f"\n--- cover archive {archive.name} ---")
    with zipfile.ZipFile(archive) as zf:
        names = [n for n in zf.namelist() if n.endswith(".mp3")]
        if len(names) != 3:
            failures.append(f"expected 3 mp3 files in the cover archive, found {len(names)}")
        for name in names:
            data = zf.read(name)
            temp = Path("/tmp/autoditag-e2e") / Path(name).name
            temp.parent.mkdir(parents=True, exist_ok=True)
            temp.write_bytes(data)
            tags = ID3(temp)
            apic = None
            for key in tags.keys():
                if key.startswith("APIC"):
                    apic = tags[key]
                    break
            if apic is None:
                failures.append(f"{name}: no APIC frame (the cover art was not embedded)")
                continue
            print(f"  {Path(name).name}: APIC mime={apic.mime} type={apic.type} bytes={len(apic.data)}")
            if apic.mime != "image/jpeg":
                failures.append(f"{name}: unexpected cover mime type {apic.mime}")
            if apic.type != 3:
                failures.append(f"{name}: the cover is not marked as the front cover")
            if len(apic.data) < 100:
                failures.append(f"{name}: the cover data is suspiciously small")


def main() -> int:
    archive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/autoditag-e2e/out/playlist.zip")
    if not archive.exists():
        print(f"FAIL: archive not found: {archive}")
        return 1

    failures = []
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        print("archive contents:")
        for name in names:
            print(f"  {name}")

        for expected in ("E2E Playlist.m3u", "E2E Playlist.m3u8"):
            if expected not in names:
                failures.append(f"{expected} is missing")

        m3u = zf.read("E2E Playlist.m3u").decode("utf-8")
        m3u8 = zf.read("E2E Playlist.m3u8").decode("utf-8")
        if m3u != m3u8:
            failures.append("the .m3u and the .m3u8 file differ")
        if not m3u.startswith("#EXTM3U\n"):
            failures.append("the playlist does not start with #EXTM3U")
        if m3u.count("#EXTINF:") != 3:
            failures.append(f"expected 3 EXTINF lines, found {m3u.count('#EXTINF:')}")

        for name, expected_tags in EXPECTED.items():
            matches = [n for n in names if n.endswith(name)]
            if not matches:
                failures.append(f"{name} is missing in the archive")
                continue
            data = zf.read(matches[0])
            temp = Path("/tmp/autoditag-e2e") / name
            temp.parent.mkdir(parents=True, exist_ok=True)
            temp.write_bytes(data)

            tags = ID3(temp)
            print(f"\n{name}")
            for frame, expected_value in expected_tags.items():
                # mutagen stores frames with a description/language under a
                # composite key (e.g. "COMM::eng"), so look them up by id
                actual = None
                for key in tags.keys():
                    if key == frame or key.startswith(f"{frame}:"):
                        actual = tags[key]
                        break
                actual_value = str(actual) if actual is not None else None
                status = "ok" if actual_value == expected_value else "MISMATCH"
                print(f"  {frame}: {actual_value!r} (expected {expected_value!r}) [{status}]")
                if actual_value != expected_value:
                    failures.append(f"{name}: {frame} is {actual_value!r}, expected {expected_value!r}")

            audio = MP3(temp)
            print(f"  duration: {audio.info.length:.2f}s, bitrate: {audio.info.bitrate // 1000}kbps")
            if not 2.5 < audio.info.length < 3.5:
                failures.append(f"{name}: unexpected duration {audio.info.length}")

    verify_cover_archive(archive.parent / "cover.zip", failures)

    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nAll checks passed: the browser output is readable by mutagen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
