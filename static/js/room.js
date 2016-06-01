'use strict'; /* global screenfull, $init, $form, sha1 */

if (screenfull.enabled)
    document.addEventListener(screenfull.raw.fullscreenchange, _ => {
        // browser support for :fullscreen is abysmal.
        for (let e of document.querySelectorAll('.is-fullscreen'))
            e.classList.remove('is-fullscreen');
        if (screenfull.element)
            screenfull.element.classList.add('is-fullscreen');
    });
else
    document.body.classList.add('no-fullscreen');


Element.prototype.insertThisBefore = function (e) {
    return e.parentElement.insertBefore(this, e);
};


Element.prototype.button = function (selector, f) {
    for (let e of this.querySelectorAll(selector)) {
        e.addEventListener('click', ev => ev.preventDefault());
        e.addEventListener('click', f);
    }
};


const RPC_STATE_INIT     = 0;
const RPC_STATE_OPEN     = 1;
const RPC_STATE_CLOSED   = 2;
const RPC_STATE_REDIRECT = 3;


let RPC = function () {
    this.nextID   = 0;
    this.state    = RPC_STATE_INIT;
    this.objects  = [];
    this.awaiting = {};
    this.handlers = {
        'RPC.Redirect': url => {
            if (url.substr(0, 2) == "//")
                url = (this.url.substr(0, 4) == "wss:" ? "wss:" : "ws:") + url;
            this.state = RPC_STATE_REDIRECT;
            this.open(url);
        },

        'RPC.Loaded': _ => {
            this.state = RPC_STATE_OPEN;
            for (let object of this.objects)
                object.load();
        }
    };
};


RPC.prototype.open = function (url) {
    if (this.socket)
        this.socket.close();

    this.state  = RPC_STATE_INIT;
    this.socket = new WebSocket(this.url = url);
    this.socket.onclose = _ => {
        if (this.state !== RPC_STATE_REDIRECT) {
            this.state = RPC_STATE_CLOSED;
            for (let object of this.objects)
                object.unload();
        }
    };

    this.socket.onmessage = ev => {
        let msg = JSON.parse(ev.data);

        if (msg.id === undefined)
            if (msg.method in this.handlers)
                this.handlers[msg.method](...msg.params);

        if (msg.id in this.awaiting) {
            let cb = this.awaiting[msg.id];
            delete this.awaiting[msg.id];
            if (msg.error === undefined)
                cb.resolve(msg.result);
            else
                cb.reject(msg.error);
        }
    };
};


RPC.prototype.register = function (obj) {
    if (this.state === RPC_STATE_OPEN)
        obj.load();
    if (this.state === RPC_STATE_CLOSED)
        obj.unload();
    this.objects.push(obj);
};


RPC.prototype.send = function (method, ...params) {
    let id = this.nextID++;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => { this.awaiting[id] = { resolve, reject }; });
};


let delayedPair = (delay, f, g) => {
    let t;
    return _ => {
        f();
        window.clearTimeout(t);
        t = window.setTimeout(() => { t = undefined; g(); }, delay);
    };
};


let getParentStream = e => {
    for (; e !== null; e = e.parentElement)
        if (e.rpc !== undefined)
            return e;
    return null;
};


$form.onDocumentReload = doc => {
    let move = (src, dst, selector) => {
        let a = src.querySelector(selector);
        let b = dst.querySelector(selector);
        if (a && b) {
            b.parentElement.replaceChild(a, b);
            b.remove();
            if (dst === document)
                $init.all(a);
        }
    };

    move(document, doc, '.stream-header .viewers');
    move(doc, document, '.stream-header');
    move(doc, document, '.stream-meta');
    move(doc, document, 'nav');
    for (let modal of document.querySelectorAll('.modal-bg'))
        modal.remove();
    return true;
};


Object.assign($init, {
    '[data-stream-id]'(e) {
        let proto = location.protocol === 'https:' ? 'wss' : 'ws';
        e.rpc = new RPC();
        e.rpc.open(`${proto}://${location.host}/stream/${encodeURIComponent(e.dataset.streamId)}`);
    },

    '.player-block'(e) {
        e.button('.theatre',  _ => e.classList.add('theatre'));
        e.button('.collapse', _ => e.classList.remove('theatre'));
    },

    '.player'(e) {
        // TODO playing, waiting, stalled (not sure whether these events are actually emitted)
        let video  = e.querySelector('video');
        let status = e.querySelector('.status');
        let volume = e.querySelector('.volume');

        let setStatus = (short, long) => {
            e.dataset.status = short;
            status.textContent = long || short;
        };

        let onTimeUpdate = t =>
            // let leftPad = require('left-pad');
            setStatus('playing', `${(t / 60)|0}:${t % 60 < 10 ? '0' : ''}${(t|0) % 60}`);

        let onError = code => setStatus(
              code === 4 ? (stream && stream.rpc.state === RPC_STATE_OPEN ? 'stopped' : 'ended') :'error',

              code === 1 ? 'aborted'
            : code === 2 ? 'network error'
            : code === 3 ? 'decoding error'
            : code === 4 ? (stream && stream.rpc.state === RPC_STATE_OPEN ? 'stopped' : 'stream ended')
            : 'unknown error');

        video.addEventListener('loadstart',      _ => setStatus('loading'));
        video.addEventListener('loadedmetadata', _ => setStatus('loading', 'buffering'));
        video.addEventListener('timeupdate',     _ => onTimeUpdate(video.currentTime));
        video.addEventListener('ended',          _ => onError(4 /* "unsupported media" */));
        video.addEventListener('error',          _ => onError(video.error.code));

        let stream = getParentStream(e);
        let play = () => {
            if (stream && stream.rpc.state === RPC_STATE_OPEN) {
                setStatus('loading');
                e.dataset.connected = 1;
                // TODO measure connection speed, request a stream
                video.src = stream.rpc.url.replace('ws', 'http');
                video.play();
            }
        };

        let stop = () => {
            setStatus('loading');
            video.src = '';
            if (stream && stream.rpc.state !== RPC_STATE_OPEN)
                delete e.dataset.connected;
        };

        if (stream) {
            setStatus('loading', 'connecting');
            stream.rpc.register({ load: play, unload: stop });
        }

        let showControls = delayedPair(3000,
            () => e.classList.remove('hide-controls'),
            () => e.classList.add('hide-controls'));

        e.addEventListener('mousemove', showControls);
        e.addEventListener('focusin',   showControls);
        e.addEventListener('keydown',   showControls);
        e.button('.play', play);
        e.button('.stop', stop);
        e.button('.mute',       _ => video.muted = true);
        e.button('.unmute',     _ => video.muted = false);
        e.button('.fullscreen', _ => screenfull.request(e));
        e.button('.collapse',   _ => screenfull.exit());

        let onVolumeChange = _ => {
            volume.querySelector('.slider').style.width = `${video.volume * 100}%`;
            if (video.muted)
                e.classList.add('muted');
            else
                e.classList.remove('muted');
            localStorage.setItem('volume', String(video.volume));
            if (video.muted)
                localStorage.setItem('muted', '1');
            else
                localStorage.removeItem('muted');
        };

        let onVolumeSelect = ev => {
            ev.preventDefault();
            let r = volume.getBoundingClientRect();
            let x = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / (r.right - r.left);
            video.volume = Math.min(1, Math.max(0, x));
            video.muted  = false;
        };

        let savedVolume = parseFloat(localStorage.getItem('volume'));
        if (!isNaN(savedVolume) && 0 <= savedVolume && savedVolume <= 1)
            video.volume = savedVolume;
        video.muted = !!localStorage.getItem('muted');

        video.addEventListener('volumechange', onVolumeChange);
        // when styling <input type="range"> is too hard
        volume.addEventListener('mousedown',  onVolumeSelect);
        volume.addEventListener('touchstart', onVolumeSelect);
        volume.addEventListener('touchmove',  onVolumeSelect);
        volume.addEventListener('mousedown',  _ => volume.addEventListener('mousemove', onVolumeSelect));
        volume.addEventListener('mouseup',    _ => volume.removeEventListener('mousemove', onVolumeSelect));
        volume.addEventListener('mouseleave', _ => volume.removeEventListener('mousemove', onVolumeSelect));
        volume.addEventListener('keydown',    ev =>
            video.volume = ev.keyCode === 37 ? Math.max(0, video.volume - 0.05)  // left arrow
                         : ev.keyCode === 39 ? Math.min(1, video.volume + 0.05)  // right arrow
                         : video.volume);
        onVolumeChange(null);
    },

    '.stream-header'(e) {
        e.button('.edit', ev => {
            let name = e.querySelector('.name');
            let t = $init.template('edit-name-template');
            let f = t.querySelector('form');
            let i = f.querySelector('input');
            f.addEventListener('reset',  _  => f.remove());
            f.insertThisBefore(ev.currentTarget);
            i.value = name.textContent;
            i.focus();
        });

        let stream = getParentStream(e);
        if (stream)
            stream.rpc.handlers['Stream.ViewerCount'] = n =>
                e.querySelector('.viewers').textContent = n;
    },

    '.stream-about'(e) {
        e.button('.edit', ev => {
            let t = $init.template('edit-panel-template');
            let f = t.querySelector('form');
            let i = f.querySelector('textarea');
            f.addEventListener('reset', _ => f.remove());

            let id = ev.currentTarget.dataset.panel;
            if (id) {
                f.querySelector('[name="id"]').value = id;
                f.querySelector('.remove').addEventListener('click', () => {
                    f.setAttribute('action', '/user/del-stream-panel');
                    f.dispatchEvent(new Event('submit'));
                });
            } else {
                f.querySelector('.remove').remove();
            }

            f.insertThisBefore(ev.currentTarget);
            i.value = ev.currentTarget.parentElement.querySelector('[data-markup=""]').textContent;
            i.focus();
        });
    },

    '.chat'(root) {
        let rpc  = getParentStream(root).rpc;
        let log  = root.querySelector('.log');
        let form = root.querySelector('.input-form');
        let text = root.querySelector('.input-form .input');

        let autoscroll = (domModifier) => {
            let atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight;
            domModifier();
            if (atBottom)
                log.scrollTop = log.scrollHeight;
        };

        let handleErrors = (form, promise, withMessage) => {
            $form.disable(form);
            return promise.then(() => {
                $form.enable(form);
                form.classList.remove('error');
            }).catch((e) => {
                $form.enable(form);
                form.classList.add('error');
                form.querySelector('.error').textContent = e.message;
                throw e;
            });
        };

        root.querySelector('.login-form').addEventListener('submit', function (ev) {
            ev.preventDefault();
            handleErrors(this, rpc.send('Chat.SetName', this.querySelector('.input').value));
        });

        form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            handleErrors(form, rpc.send('Chat.SendMessage', text.value), true).then(() => {
                log.scrollTop = log.scrollHeight;
                text.value = '';
                text.select();
            });
        });

        let submitParentForm = (ev) => {
            ev.preventDefault();
            for (let e = ev.target; e !== null; e = e.parentElement)
                if (e.tagName === 'FORM')
                    return e.dispatchEvent(new Event('submit', {cancelable: true}));
        };

        root.addEventListener('keydown', (ev) => {
            if (ev.keyCode === 13 && !ev.shiftKey)  // carriage return
                submitParentForm(ev);
        });

        root.button('.button[data-submit]', submitParentForm);

        let stringColor = (str) => {
            let h = parseInt(sha1(str).slice(32), 16);
            return `hsl(${h % 359},${(h / 359|0) % 60 + 30}%,${((h / 359|0) / 60|0) % 30 + 50}%)`;
        };

        rpc.handlers['Chat.Message'] = (name, text, login) =>
            autoscroll(() => {
                let entry = $init.template('chat-message-template');
                let e = entry.querySelector('.name');
                // TODO maybe do this server-side? that'd allow us to hash the IP instead...
                e.style.color = stringColor(`${name.length}:${name}${login}`);
                e.textContent = name;
                if (!login) {
                    e.setAttribute('title', 'Anonymous user');
                    e.classList.add('anon');
                } else {
                    e.setAttribute('title', login);
                }
                entry.querySelector('.text').textContent = text;
                log.appendChild(entry);
            });

        rpc.handlers['Chat.AcquiredName'] = (name, login) =>
            autoscroll(() => {
                if (name === "") {
                    root.classList.remove('logged-in');
                    root.querySelector('.login-form').classList.add('error');
                } else {
                    root.classList.add('logged-in');
                    text.select();
                }
            });

        rpc.register({
            load() {
                rpc.send('Chat.RequestHistory');
                root.classList.add('online');
            },

            unload() {
                root.classList.remove('online');
            },
        });
    },
});
