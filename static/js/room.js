'use strict';


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

        if (msg.id === undefined)
            if (msg.method in cbs_by_code)
                cbs_by_code[msg.method](...msg.params);

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


let ViewNode = function (root, stream) {
    let view = root.querySelector('video');
    let rpc  = null;

    view.addEventListener('loadstart', () => {
        root.classList.remove('uk-icon-warning');
        root.classList.add('w-icon-loading');
    });

    view.addEventListener('loadedmetadata', () => {
        root.classList.remove('uk-icon-warning');
        root.classList.remove('w-icon-loading');
        root.querySelector('.pad').remove();
    });

    let onDone = () => {
        root.classList.remove('w-icon-loading');
        root.classList.add('uk-icon-warning');
    };

    view.addEventListener('error', onDone);
    view.addEventListener('ended', onDone);

    return {
        onLoad: (socket) => {
            rpc = socket;
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
    let log = root.querySelector('.log');
    let msg = log.querySelector('.message');
    let rpc = null;
    msg.remove();

    let form = root.querySelector('.input-form');
    let text = form.querySelector('.input');

    text.addEventListener('keydown', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ? ev.preventDefault() : null));

    text.addEventListener('keyup', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ? form.dispatchEvent(new Event('submit')) : null));

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (rpc && text.value) {
            rpc.send('Chat.SendMessage', text.value).then(() => {
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
            rpc.send('Chat.SetName', login.value).then(() => {
                lform.remove();
                text.focus();
            });
        }
    });

    return {
        onLoad: (socket) => {
            rpc = socket;
            rpc.callback('Chat.Message', (name, text) => {
                let entry = msg.cloneNode(true);
                entry.querySelector('.name').textContent = name;
                entry.querySelector('.text').textContent = text;
                log.appendChild(entry);
            });

            rpc.send('Chat.RequestHistory');
            root.classList.add('active');
        },

        onUnload: () => {
            rpc = null;
            root.classList.remove('active');
        },
    };
};


let stream = document.body.getAttribute('data-stream-id');
let view   = new ViewNode(document.querySelector('.w-view-container'), stream);
let chat   = new ChatNode(document.querySelector('.w-chat-container'));
let rpc    = new RPC(`ws${window.location.protocol == 'https:' ? 's' : ''}://`
                     + `${window.location.host}/stream/${stream}`,
                     chat, view);
