## webmcast

An experimental video streaming service.

### The Idea

A generic WebM file looks like this:

![EBML.](https://github.com/pyos/webmcast/raw/master/README.rsrc/1-webm.png)

By setting the Segment's length to one of 7 reserved values
(all of which mean "indeterminate"), it's possible to produce
an infinite stream.

![Infinite EBML.](https://github.com/pyos/webmcast/raw/master/README.rsrc/2-webm-indeterminate.png)

Let's say a client connects at some point.

![Barely in time for the best part.](https://github.com/pyos/webmcast/raw/master/README.rsrc/3-client.png)

So we give it the file header and an infinite segment with
a description of tracks, then start forwarding clusters/blocks starting
from the (chronologically) next keyframe!

![Oops, sorry, it was dropped.](https://github.com/pyos/webmcast/raw/master/README.rsrc/4-clients-data.png)

Additionally, a WebM file (even an infinite one) can contain multiple segments.
These segments will be played one after another if they contain the same tracks,
so we can spawn a copy of the original stream with a different bitrate, then
switch the client over by starting a new segment if a slow connection is detected.
Kind of like adaptive streaming, see?

![It's not the size of a cluster, it's the contents.](https://github.com/pyos/webmcast/raw/master/README.rsrc/5-many-segments-such-stream.png)

Sounds simple, huh? So simple, in fact, someone probably already
thought to do that. That's correct! We're
[live-streaming Matroska](https://matroska.org/technical/streaming/index.html)!

### The Implementation

This code!

```bash
pip install -r requirements.txt
python mkffi.py
```

To start the server:

```bash
python -m webmcast.server
```

To start a stream, send a WebM to `/stream_name.webm` over an HTTP POST request:

```bash
# When streaming from a file, don't forget `-re` so that ffmpeg
# doesn't remux the video faster than it will be played back.
# To stream with audio, add `-c:a opus -b:a 64k` before `-f webm`.
ffmpeg ... -c:v vp8 -keyint_min 60 -g 60 \
           -deadline realtime -static-thresh 0 \
           -speed 6 -max-intra-rate 300 -b:v 2000k \
           -f webm http://127.0.0.1:8000/stream_name.webm
```

To view the stream, open either `/stream_name` in a browser
or `/stream_name.webm` in a player.

### The Reality (alt. name: "Known Issues")

As always, what looks good on paper doesn't always work in practice.

  * There are 7 ways to encode an "indeterminate" length. Naturally, the one that
    ffmpeg happens to use makes Chrome (48.0.2564.109/CrOS) crash. (The server will
    automatically recode it as one of the acceptable variants.)

  * When streaming from a webcam (*not* a random downloaded file for some reason) in VP9,
    Chrome crashes upon receiving the first frame (even when simply opening a file recorded
    with ffmpeg), Firefox loses most of the color (and stutters; however, this is likely
    because encoding & decoding VP9 is too CPU-intensive for my computer to handle), and
    VLC complains about a missing reference frame. Curiously, `curl | ffmpeg` accepts
    the stream just fine. All four use the same library (libvpx) for decoding, so...WTF?

  * VP8 is OK, though.

Looks like all those overcomplicated standards like HLS or DASH exist for a reason, huh?
Even if that reason is the same reason we have "transpilers" and "shims".
