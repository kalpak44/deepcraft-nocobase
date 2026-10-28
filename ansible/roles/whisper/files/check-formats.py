#!/usr/bin/env python3
"""Verify that whisper-server converts formats its decoder cannot read.

Every container in FORMATS is generated from SAMPLE and run through the same
ffmpeg command the server uses. The .m4a is then posted to /inference and its
transcript checked, so this covers both ffmpeg and the server path.

A script rather than ansible.builtin.uri because uri base64-wraps file parts,
which whisper-server does not decode.

usage: check-formats.py URL SAMPLE
"""

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from typing import NamedTuple, Optional

# Two seconds contains the marker and keeps the one model call cheap.
CLIP_SECONDS = "2"
MARKER = "fellow americans"

# H.263 (3GP) only allows a few picture sizes; this one works for every encoder.
VIDEO_SIZE = "176x144"
VIDEO_RATE = "2"


class Format(NamedTuple):
    extension: str
    mime: str
    audio: str
    bitrate: Optional[str]
    video: Optional[str] = None


# Representative containers, not an allowlist: ffmpeg's demuxer decides. The
# video entries prove the audio track is extracted.
FORMATS = (
    Format("m4a", "audio/mp4", "aac", "64k"),
    Format("aac", "audio/aac", "aac", "64k"),
    Format("webm", "audio/webm", "libopus", "32k"),
    Format("ogg", "audio/ogg", "libopus", "32k"),
    Format("mp3", "audio/mpeg", "libmp3lame", "64k"),
    Format("flac", "audio/flac", "flac", None),
    Format("wma", "audio/x-ms-wma", "wmav2", "64k"),
    Format("mp4", "video/mp4", "aac", "64k", "libx264"),
    Format("mov", "video/quicktime", "aac", "64k", "libx264"),
    Format("mkv", "video/x-matroska", "libopus", "32k", "libx264"),
    Format("avi", "video/x-msvideo", "libmp3lame", "64k", "mpeg4"),
    Format("wmv", "video/x-ms-wmv", "wmav2", "64k", "wmv2"),
    Format("3gp", "video/3gpp", "aac", "32k", "h263"),
)

# Only the original failure case is posted; video uses the same server code, so
# a second request would just cost another 30-second window.
TRANSCRIBE = ("m4a",)


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def generate(sample, fmt, path):
    """Write a short clip of `fmt` derived from the sample."""
    if fmt.video:
        command = [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s={VIDEO_SIZE}:r={VIDEO_RATE}",
            "-t", CLIP_SECONDS, "-i", sample,
            "-map", "0:v", "-map", "1:a",
            "-c:v", fmt.video, "-pix_fmt", "yuv420p",
            "-c:a", fmt.audio, "-b:a", fmt.bitrate, "-shortest",
            path,
        ]
    else:
        command = [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-t", CLIP_SECONDS, "-i", sample, "-vn",
            "-c:a", fmt.audio,
        ]
        if fmt.bitrate:
            command += ["-b:a", fmt.bitrate]
        command.append(path)

    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        fail(f"ffmpeg could not make a {fmt.extension} from {sample}")


def ffmpeg_converts(path):
    """Run the server's conversion command and require audio to come out."""
    converted = f"{path}.check.wav"
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-i", path,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            converted,
        ],
        check=False,
    )
    if result.returncode != 0:
        return False
    try:
        size = os.path.getsize(converted)
    except OSError:
        return False
    # A failed mapping can still write a header; 1s of 16 kHz mono is 32 KB.
    return size > 32000


def multipart(fields):
    """Encode fields as multipart/form-data, without touching the file bytes."""
    boundary = f"----whisper-check-{uuid.uuid4().hex}"
    body = bytearray()
    for name, value in fields:
        body += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            filename, content_type, content = value
            body += (
                f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode()
            body += content
        else:
            body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            body += str(value).encode()
        body += b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return boundary, bytes(body)


def transcribe(url, path, content_type):
    with open(path, "rb") as handle:
        content = handle.read()

    boundary, body = multipart(
        (
            ("file", (os.path.basename(path), content_type, content)),
            ("response_format", "json"),
            # Fixed language/temperature: this checks conversion, not detection.
            ("language", "en"),
            ("temperature", "0.0"),
        )
    )

    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        fail(f"{os.path.basename(path)}: HTTP {err.code}: {detail}")
    except Exception as err:  # noqa: BLE001 - surfaced verbatim to the play
        fail(f"{os.path.basename(path)}: {err}")

    try:
        return json.loads(payload).get("text", "")
    except ValueError:
        fail(f"{os.path.basename(path)}: response was not JSON: {payload[:200]!r}")


def main():
    if len(sys.argv) != 3:
        print("usage: check-formats.py URL SAMPLE", file=sys.stderr)
        return 2

    url, sample = sys.argv[1], sys.argv[2]

    with tempfile.TemporaryDirectory(prefix="whisper-check-") as tmp:
        paths = {}
        for fmt in FORMATS:
            path = os.path.join(tmp, f"check.{fmt.extension}")
            generate(sample, fmt, path)
            if not ffmpeg_converts(path):
                fail(f"ffmpeg could not extract audio from {fmt.mime}")
            paths[fmt.extension] = path
        print(f"ok: {len(paths)} audio and video containers convert", flush=True)

        for extension in TRANSCRIBE:
            fmt = next(item for item in FORMATS if item.extension == extension)
            text = transcribe(url, paths[extension], fmt.mime)
            if MARKER not in text.lower():
                fail(
                    f"{fmt.extension} was accepted but came back as "
                    f"{text.strip()!r}; expected it to contain {MARKER!r}"
                )
            print(
                f"ok: {fmt.extension} ({fmt.mime}) transcribed through /inference",
                flush=True,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
