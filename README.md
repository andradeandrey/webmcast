## webmcast

An experimental video streaming service.

### The Idea

A generic WebM file looks like this:

![EBML.](https://raw.githubusercontent.com/pyos/webmcast/resource-fork/README.md/1-webm.png)

By setting the Segment's length to one of 7 reserved values
(all of which mean "indeterminate"), it's possible to produce
an infinite stream.

![Infinite EBML.](https://raw.githubusercontent.com/pyos/webmcast/resource-fork/README.md/2-webm-indeterminate.png)

Let's say a client connects at some point.

![Barely in time for the best part.](https://raw.githubusercontent.com/pyos/webmcast/resource-fork/README.md/3-client.png)

So we give it the file header and an infinite segment with
a description of tracks, then start forwarding clusters/blocks starting
from the (chronologically) next keyframe!

![Oops, sorry, it was dropped.](https://raw.githubusercontent.com/pyos/webmcast/resource-fork/README.md/4-clients-data.png)

Additionally, a WebM file (even an infinite one) can contain multiple segments.
These segments will be played one after another if they contain the same tracks,
so we can spawn a copy of the original stream with a different bitrate, then
switch the client over by starting a new segment if a slow connection is detected.
Kind of like adaptive streaming, see?

![It's not the size of a cluster, it's the contents.](https://raw.githubusercontent.com/pyos/webmcast/resource-fork/README.md/5-many-segments-such-stream.png)

Sounds simple, huh? So simple, in fact, someone probably already
thought to do that. That's correct! We're
[live-streaming Matroska](https://matroska.org/technical/streaming/index.html)!

### The Implementation

This code!

```bash
go build -i
./webmcast
```

#### Broadcast mode

PUT/POST a WebM to `/stream/<name>`

*Not implemented: the server should require a security token for that.*

```bash
server=http://localhost:8000
name=test

ffmpeg $source \
    -c:v vp8 -b:v 2000k -keyint_min 60 -g 60 -deadline realtime -speed 6 \
    -c:a opus -b:a 64k \
    -f webm $server/stream/$name
```

Or with gstreamer:

```bash
gst-launch webmmux name=mux streamable=true ! souphttpclientsink location=$server/stream/$name \
           $video_source ! videoconvert ! vp8enc keyframe-max-dist=60 deadline=1 ! queue ! mux.video_0 \
           $audio_source ! vorbisenc ! queue ! mux.audio_0
```

Tips:

  * `-g` [or `keyframe-max-dist`] controls the spacing between keyframes.
    Lower values allow the stream to start faster as it has to begin
    with a keyframe, while higher values may (but most likely will not) provide better
    compression.

  * The stream may be split arbitrarily into many requests.
    For example, gstreamer sends each frame as a separate PUT by default.

  * The stream is kept alive for some time after a payload-carrying request ends.
    Thus, should the connection fail, it is possible to reconnect and continue
    streaming as if nothing happened. (Duplicate WebM headers are ignored.)

  * Multiple WebM streams can be concatenated (or sent as multiple requests to
    the same stream), as long as they contain the same tracks and use the same codecs.
    For example, you can switch bitrate mid-stream by restarting ffmpeg.

  * Sending frames faster than they are played back is OK. However, the server
    does not have a buffer, so any frames sent before a client has connected
    will not be received by said client, regardless of the actual passage of time.
    *ffmpeg tip: `-re` caps output speed at one frame per frame, if that makes any sense.*

#### Dumb mode

GET `/stream/<name>` to receive a continuous stream with default parameters.

#### Signaled mode

Upgrade to WebSocket at `/stream/<name>` to create a signaling channel,
then send JSON-RPC 2.0 messages.

**Methods**

  * `Chat.SetName(name: String) -> null`
  * `Chat.SendMessage(text: String) -> null`
  * `Chat.RequestHistory() -> null` (the request is fulfilled in form of notifications)
  * Not implemented: the `Stream` object (connect/disconnect/measure connection rate, ...)

**Notifications**

  * `Chat.Message(name: String, text: String)`

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
