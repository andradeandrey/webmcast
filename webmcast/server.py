import cno
import signal
import asyncio
import weakref
import itertools
import contextlib

from .c import ffi
from .c.lib import *


@ffi.def_extern('on_chunk_cb', -1)
def _(handle, data, size, force):
    queue = ffi.from_handle(handle)
    if not force and queue.qsize() > 0:
        return -1
    queue.put_nowait(ffi.buffer(data, size)[:])
    return 0


class Broadcast (asyncio.Event):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.obj = broadcast_start()

    def __del__(self):
        broadcast_stop(self.obj)

    def stop(self):
        self.set()

    def send(self, chunk):
        s = ffi.new('uint8_t[]', chunk)
        if broadcast_send(self.obj, s, len(chunk)):
            raise ValueError('bad data')

    def connect(self, queue, skip_headers=False):
        handle = ffi.new_handle(queue)
        slot = broadcast_connect(self.obj, on_chunk_cb, handle, skip_headers)
        if slot < 0:
            raise MemoryError
        return handle, slot

    def disconnect(self, handle):
        handle, slot = handle
        return broadcast_disconnect(self.obj, slot)


async def handle(req, streams = weakref.WeakValueDictionary(),
                      collectors = {}):
    if req.path.endswith('.webm'):
        stream_id = req.path.lstrip('/')[:-5]

        if req.method == 'POST':
            if stream_id in streams:
                try:
                    collectors.pop(stream_id).cancel()
                except KeyError:
                    return (await req.respond(403, [], b'stream id already taken'))
                stream = streams[stream_id]
            else:
                streams[stream_id] = stream = Broadcast(loop=req.conn.loop)
            try:
                while True:
                    chunk = await req.payload.read(16384)
                    if chunk == b'':
                        break
                    stream.send(chunk)
            finally:
                async def collect():
                    await asyncio.sleep(10, loop=req.conn.loop)
                    stream.stop()
                collectors[stream_id] = asyncio.ensure_future(collect(), loop=req.conn.loop)
            return (await req.respond(204, [], b''))

        try:
            stream = streams[stream_id]
        except KeyError:
            return (await req.respond(404, [], b'this stream is offline'))

        queue = cno.Channel(loop=req.conn.loop)

        async def writer():
            handle = stream.connect(queue)
            try:
                # XXX we can switch streams in the middle of the video
                #     by disconnecting the queue and reconnecting it
                #     with skip_headers=True. (that would make the server
                #     start a new webm segment) this might be useful
                #     for adaptive streaming.
                await stream.wait()
            finally:
                stream.disconnect(handle)
                queue.close()

        writer = asyncio.ensure_future(writer(), loop=req.conn.loop)
        try:
            return (await req.respond(200, [('content-type', 'video/webm')], queue))
        finally:
            writer.cancel()

    if req.method != 'GET':
        return (await req.respond(405, [], b'/stream_name**.webm**'))

    stream_id = req.path.strip('/')

    if stream_id not in streams:
        return (await req.respond(404, [], b'this stream is offline'))

    await req.respond(200, [('content-type', 'text/html')],
        '''<!doctype html>
            <html>
                <head>
                    <meta charset='utf-8' />
                    <title>asd</title>
                </head>
                <body>
                    <video autoplay preload='none'>
                        <source src='/{}.webm' type='video/webm' />
                    </video>
            </html>
        '''.format(stream_id).encode('utf-8')
    )


async def main(loop):
    http = await loop.create_server(lambda: cno.Server(loop, handle), '', 8000)
    try:
        print('http://127.0.0.1:8000/')
        await asyncio.Future(loop=loop)
    finally:
        http.close()


loop = asyncio.get_event_loop()
loop.run_until_complete(main(loop))
