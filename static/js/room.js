'use strict'; /* global screenfull */

if (screenfull.enabled) {
    document.addEventListener(screenfull.raw.fullscreenchange, () => {
        if (screenfull.isFullscreen)
            screenfull.element.classList.add('is-fullscreen');
        else
            document.querySelector('.is-fullscreen').classList.remove('is-fullscreen');
    });

    document.addEventListener(screenfull.raw.fullscreenerror, () =>
        document.body.classList.add('no-fullscreen'));
} else
    document.body.classList.add('no-fullscreen');

let RPC = function(url, ...objects) {
    let cbs_by_id   = {};
    let cbs_by_code = {};
    let id = 0;

    let socket = new WebSocket(url);
    let self = {
        send: (method, ...params) => {
            return new Promise((resolve, reject) => {
                socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
                cbs_by_id[id] = { resolve, reject };
                id = (id + 1) & 0x7FFF;
            });
        },

        callback: (code, cb) => {
            if (cb === undefined)
                delete cbs_by_code[code];
            else
                cbs_by_code[code] = cb;
        },
    };

    socket.onopen = () => {
        for (let object of objects)
            object.onLoad(self);
    };

    socket.onclose = (ev) => {
        for (let object of objects)
            object.onUnload();
    };

    socket.onmessage = (ev) => {
        let msg = JSON.parse(ev.data);

        if (msg.id === undefined) {
            if (msg.method in cbs_by_code)
                cbs_by_code[msg.method](...msg.params);
            else
                console.log('unhandled notification', msg);
        }

        if (msg.id in cbs_by_id) {
            let cb = cbs_by_id[msg.id];
            delete cbs_by_id[msg.id];
            if (msg.error === undefined)
                cb.resolve(msg.result);
            else
                cb.reject(msg.error);
        }
    };

    return self;
};


let ViewNode = function (root, info, stream) {
    let rpc    = null;
    let view   = root.querySelector('video');
    let status = root.querySelector('.status');
    let volume = root.querySelector('.volume');

    let onVolumeSelect = (e) => {
        e.preventDefault();
        let r = volume.getBoundingClientRect();
        let x = Math.min(r.right, Math.max(r.left, e.touches ? e.touches[0].clientX : e.clientX));
        view.volume = (x - r.left) / (r.right - r.left);
    };

    let onVolumeChange = (v, muted) => {
        let e = volume.querySelector('.slider');
        let r = volume.getBoundingClientRect();
        e.style.left = `${v * (r.right - r.left)}px`;
        e.style.top = `${(1 - v) * (r.bottom - r.top)}px`;
        if (muted)
            root.classList.add('muted');
        else
            root.classList.remove('muted');
    };

    let onTimeUpdate = (t) => {
        // let leftPad = require('left-pad');
        status.textContent = `${(t / 60)|0}:${t % 60 < 10 ? '0' : ''}${(t|0) % 60}`;
    };

    let onDone = () => {
        root.setAttribute('data-status',
            view.error === null || view.error.code === 4 ? 'ended' : 'error');
        status.textContent = view.error === null   ? 'stream ended'
                           : view.error.code === 1 ? 'aborted'
                           : view.error.code === 2 ? 'network error'
                           : view.error.code === 3 ? 'decoding error'
                           : /* view.error.code === 4 ? */ 'stream ended';
    };

    let onLoad = () => {
        root.setAttribute('data-status', 'loading');
        status.textContent = 'loading';
    };

    let onPlay = () => {
        root.setAttribute('data-status', 'playing');
        status.textContent = 'playing';
    };

    view.addEventListener('loadstart',      onLoad);
    view.addEventListener('loadedmetadata', onPlay);
    view.addEventListener('error',          onDone);
    view.addEventListener('ended',          onDone);
    view.addEventListener('timeupdate', () => onTimeUpdate(view.currentTime));
    view.addEventListener('volumechange', () => onVolumeChange(view.volume, view.muted));
    // TODO playing, waiting, stalled (not sure whether these events are actually emitted)

    volume.addEventListener('mousedown',  onVolumeSelect);
    volume.addEventListener('touchstart', onVolumeSelect);
    volume.addEventListener('touchmove',  onVolumeSelect);
    volume.addEventListener('mousedown', (e) =>
        volume.addEventListener('mousemove', onVolumeSelect));
    volume.addEventListener('mouseup', () =>
        volume.removeEventListener('mousemove', onVolumeSelect));
    volume.addEventListener('mouseleave', () =>
        volume.removeEventListener('mousemove', onVolumeSelect));
    onVolumeChange(view.volume, view.muted);

    root.querySelector('.mute').addEventListener('click', () => {
        view.muted = !view.muted;
    });

    root.querySelector('.theatre').addEventListener('click', () =>
        document.body.classList.add('theatre'));

    root.querySelector('.fullscreen').addEventListener('click', () =>
        screenfull.request(root));

    root.querySelector('.collapse').addEventListener('click', () => {
        document.body.classList.remove('theatre');
        screenfull.exit();
    });

    onLoad();
    return {
        onLoad: (socket) => {
            rpc = socket;
            rpc.callback('Stream.ViewerCount', (n) => {
                info.querySelector('.viewers').textContent = n;
            });
            // TODO measure connection speed, request a stream
            view.src = `/stream/${stream}`;
            view.play();
        },

        onUnload: () => {
            rpc = null;
            onDone();
        },
    };
};


let ChatNode = function (root) {
    let form = root.querySelector('.input-form');
    let text = form.querySelector('.input');
    let log  = root.querySelector('.log');
    let msg  = root.querySelector('.message-template');
    let rpc  = null;

    text.addEventListener('keydown', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ? ev.preventDefault() : null));

    text.addEventListener('keyup', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ?
            form.dispatchEvent(new Event('submit', {cancelable: true})) : null));

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (rpc && text.value) {
            rpc.send('Chat.SendMessage', text.value).then(() => {
                log.scrollTop = log.scrollHeight;
                text.value = '';
                text.focus();
            });
        }
    });

    let lform = root.querySelector('.login-form');
    let login = lform.querySelector('.input');

    lform.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (rpc && login.value) {
            rpc.send('Chat.SetName', login.value);
        }
    });

    return {
        onLoad: (socket) => {
            rpc = socket;
            rpc.callback('Chat.Message', (name, text) => {
                let rect = log.getBoundingClientRect();
                let scroll = log.scrollTop + (rect.bottom - rect.top) >= log.scrollHeight;
                let entry = document.importNode(msg.content, true);
                entry.querySelector('.name').textContent = name;
                entry.querySelector('.text').textContent = text;
                log.appendChild(entry);
                if (scroll)
                    log.scrollTop = log.scrollHeight;
            });

            rpc.callback('Chat.AcquiredName', (name) => {
                root.classList.add('logged-in');
                text.focus();
                log.scrollTop = log.scrollHeight;
            });

            rpc.send('Chat.RequestHistory');
            root.classList.add('online');
        },

        onUnload: () => {
            rpc = null;
            root.classList.remove('online');
        },
    };
};


let nativeScrollbarWidth = (() => {
    let e = document.createElement('div');
    e.style.position = 'absolute';
    e.style.top      = '-200px';
    e.style.width    = '100px';
    e.style.height   = '100px';
    e.style.overflow = 'scroll';
    document.body.appendChild(e);
    let r = e.offsetWidth - e.clientWidth;
    e.remove();
    return r;
})();


let createCustomScrollbar = (e) => {
    if (nativeScrollbarWidth === 0)
        return;

    e.style.overflowY   = 'scroll';
    e.style.marginRight = `-${nativeScrollbarWidth}px`;

    let track = document.createElement('div');
    let thumb = document.createElement('div');
    thumb.classList.add('thumb');
    track.classList.add('scrollbar');
    track.classList.add('hidden');
    track.appendChild(thumb);

    let timeout = null;
    let show = () => {
        thumb.style.top          =  `${e.scrollTop    / e.scrollHeight * track.clientHeight}px`;
        thumb.style.height       =  `${e.clientHeight / e.scrollHeight * track.clientHeight}px`;
        track.style.marginTop    =  `${e.scrollTop}px`;
        track.style.marginBottom = `-${e.scrollTop}px`;
        if (e.scrollHeight > e.clientHeight) {
            if (timeout !== null)
                window.clearTimeout(timeout);
            track.classList.remove('hidden');
            timeout = window.setTimeout(() => track.classList.add('hidden'), 1000);
        } else
            timeout = null;
    };

    e.appendChild(track);
    e.addEventListener('scroll',    show);
    e.addEventListener('mousemove', show);
};


for (let es = document.querySelectorAll('[data-scrollable]'), i = 0; i < es.length; i++)
    createCustomScrollbar(es[i]);


let stream = document.body.getAttribute('data-stream-id');
let view   = new ViewNode(document.querySelector('.player'),
                          document.querySelector('.meta'), stream);
let chat   = new ChatNode(document.querySelector('.chat'));
let rpc    = new RPC(`ws${window.location.protocol == 'https:' ? 's' : ''}://`
                     + `${window.location.host}/stream/${encodeURIComponent(stream)}`,
                     chat, view);
