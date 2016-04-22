'use strict'; /* global screenfull */

if (screenfull.enabled) {
    document.addEventListener(screenfull.raw.fullscreenchange, () => {
        if (screenfull.isFullscreen)
            // browser support for :fullscreen is abysmal.
            screenfull.element.classList.add('is-fullscreen');
        else
            document.querySelector('.is-fullscreen').classList.remove('is-fullscreen');
    });

    document.addEventListener(screenfull.raw.fullscreenerror, () =>
        document.body.classList.add('no-fullscreen'));
} else {
    document.body.classList.add('no-fullscreen');
}


let RPC = function(url) {
    this.nextID   = 0;
    this.events   = {};
    this.requests = {};
    this.objects  = [];
    this.socket   = new WebSocket(url);

    this.socket.onopen = () => {
        for (let object of this.objects)
            object.onLoad();
    };

    this.socket.onclose = (ev) => {
        for (let object of this.objects)
            object.onUnload();
    };

    this.socket.onmessage = (ev) => {
        let msg = JSON.parse(ev.data);

        if (msg.id === undefined)
            if (msg.method in this.events)
                this.events[msg.method](...msg.params);

        if (msg.id in this.requests) {
            let cb = this.requests[msg.id];
            delete this.requests[msg.id];
            if (msg.error === undefined)
                cb.resolve(msg.result);
            else
                cb.reject(msg.error);
        }
    };
};


RPC.prototype.send = function (method, ...params) {
    return new Promise((resolve, reject) => {
        let id = this.nextID++ & 0xFFFF;
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        this.requests[id] = { resolve, reject };
    });
};


RPC.prototype.connect = function (event, cb) {
    if (cb === undefined)
        delete this.events[event];
    else
        this.events[event] = cb;
};


let View = function (rpc, root, stream) {
    let video  = root.querySelector('video');
    let status = root.querySelector('.status');
    let volume = root.querySelector('.volume');

    let onVolumeSelect = (e) => {
        e.preventDefault();
        let r = volume.getBoundingClientRect();
        let x = Math.min(r.right, Math.max(r.left, e.touches ? e.touches[0].clientX : e.clientX));
        video.volume = (x - r.left) / (r.right - r.left);
        video.muted  = false;
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
            video.error === null || video.error.code === 4 ? 'ended' : 'error');
        status.textContent = video.error === null   ? 'stream ended'
                           : video.error.code === 1 ? 'aborted'
                           : video.error.code === 2 ? 'network error'
                           : video.error.code === 3 ? 'decoding error'
                           : /* video.error.code === 4 ? */ 'stream ended';
    };

    let onLoadStart = () => {
        root.setAttribute('data-status', 'loading');
        status.textContent = 'loading';
    };

    let onLoadEnd = () => {
        root.setAttribute('data-status', 'playing');
        status.textContent = 'playing';
    };

    let hideCursorTimeout = null;
    let hideCursor = () => {
        showCursor();
        hideCursorTimeout = window.setTimeout(() => {
            hideCursorTimeout = null;
            document.body.classList.add('hide-cursor');
        }, 3000);
    };

    let showCursor = () => {
        if (hideCursorTimeout !== null)
            window.clearTimeout(hideCursorTimeout);
        else
            document.body.classList.remove('hide-cursor');
        hideCursorTimeout = null;
    };

    video.addEventListener('loadstart',      onLoadStart);
    video.addEventListener('loadedmetadata', onLoadEnd);
    video.addEventListener('error',          onDone);
    video.addEventListener('ended',          onDone);
    video.addEventListener('timeupdate',     () => onTimeUpdate(video.currentTime));
    video.addEventListener('volumechange'  , () => onVolumeChange(video.volume, video.muted));
    // TODO playing, waiting, stalled (not sure whether these events are actually emitted)

    video.addEventListener('mouseenter', hideCursor);
    video.addEventListener('mouseleave', showCursor);
    video.addEventListener('mouseenter', () => video.addEventListener('mousemove', hideCursor));
    video.addEventListener('mouseleave', () => video.removeEventListener('mousemove', hideCursor));

    // when styling <input type="range"> is too hard
    volume.addEventListener('mousedown',  onVolumeSelect);
    volume.addEventListener('touchstart', onVolumeSelect);
    volume.addEventListener('touchmove',  onVolumeSelect);
    volume.addEventListener('mousedown',  () => volume.addEventListener('mousemove', onVolumeSelect));
    volume.addEventListener('mouseup',    () => volume.removeEventListener('mousemove', onVolumeSelect));
    volume.addEventListener('mouseleave', () => volume.removeEventListener('mousemove', onVolumeSelect));
    onVolumeChange(video.volume, video.muted);

    root.querySelector('.mute').addEventListener('click', () => {
        video.muted = !video.muted;
    });

    root.querySelector('.theatre').addEventListener('click', () =>
        document.body.classList.add('theatre'));

    root.querySelector('.fullscreen').addEventListener('click', () =>
        screenfull.request(root));

    root.querySelector('.collapse').addEventListener('click', () => {
        document.body.classList.remove('theatre');
        screenfull.exit();
    });

    onLoadStart();
    return {
        onLoad: () => {
            // TODO measure connection speed, request a stream
            video.src = `/stream/${stream}`;
            video.play();
        },

        onUnload: () => {
            video.src = '';
        },
    };
};


let Chat = function (rpc, root) {
    let log  = root.querySelector('.log');
    let msg  = root.querySelector('.message-template');
    let form = root.querySelector('.input-form');
    let text = root.querySelector('.input-form .input');

    let autoscroll = (domModifier) => {
        let atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight;
        domModifier();
        if (atBottom)
            log.scrollTop = log.scrollHeight;
    };

    root.querySelector('.login-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        // TODO catch errors
        rpc.send('Chat.SetName', this.querySelector('.input').value);
    });

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        // TODO catch errors
        rpc.send('Chat.SendMessage', text.value).then(() => {
            log.scrollTop = log.scrollHeight;
            text.value = '';
            text.focus();
        });
    });

    text.addEventListener('keydown', (ev) =>
        // do not input line breaks without shift
        ev.keyCode === 13 && !ev.shiftKey ? ev.preventDefault() : null);

    text.addEventListener('keyup', (ev) =>
        // send the message on Enter (but not Shift+Enter)
        ev.keyCode === 13 && !ev.shiftKey ?
            form.dispatchEvent(new Event('submit', {cancelable: true})) : null);

    rpc.connect('Chat.Message', (name, text, login, isReal) => {
        autoscroll(() => {
            // TODO derive a color for the name
            // TODO show which users are actually anonymous
            let entry  = document.importNode(msg.content, true);
            entry.querySelector('.name').textContent = name;
            entry.querySelector('.text').textContent = text;
            log.appendChild(entry);
        });
    });

    rpc.connect('Chat.AcquiredName', (name, login) => {
        autoscroll(() => {
            if (name === "") {
                root.classList.remove('logged-in');
            } else {
                root.classList.add('logged-in');
                text.focus();
            }
        });
    });

    return {
        onLoad: () => {
            rpc.send('Chat.RequestHistory');
            root.classList.add('online');
        },

        onUnload: () => {
            root.classList.remove('online');
        },
    };
};


let Meta = function (rpc, meta, about, stream, owned) {
    rpc.connect('Stream.Name', (n) => {
        meta.querySelector('.name').textContent = n || `#${stream}`;
    });

    rpc.connect('Stream.About', (n) => {
        about.textContent = n;
    });

    rpc.connect('Stream.ViewerCount', (n) => {
        meta.querySelector('.viewers').textContent = n;
    });

    if (owned) {
        // ...
    }

    return { onLoad: () => {}, onUnload: () => {} };
};


let Player = function (root) {
    let stream = root.getAttribute('data-stream-id');
    let owned  = root.hasAttribute('data-owned');
    let rpc    = new RPC(`ws${window.location.protocol == 'https:' ? 's' : ''}://`
                         + `${window.location.host}/stream/${encodeURIComponent(stream)}`);

    rpc.objects = [
        new View(rpc, root.querySelector('.player'), stream),
        new Chat(rpc, root.querySelector('.chat')),
        new Meta(rpc, root.querySelector('.meta'), root.querySelector('.about'), stream, owned),
    ];

    return rpc;
};


let player = new Player(document.body);
