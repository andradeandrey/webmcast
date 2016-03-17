'use strict';


let wsc_init_view = (root) => {
    let view = root.querySelector('video');

    view.addEventListener('loadstart', () => {
        root.classList.remove('uk-icon-warning');
        root.classList.add('w-icon-loading');
    });

    view.addEventListener('loadedmetadata', () => {
        root.classList.remove('uk-icon-warning');
        root.classList.remove('w-icon-loading');
        root.querySelector('.pad').remove();
    });

    view.addEventListener('error', () => {
        root.classList.remove('w-icon-loading');
        root.classList.add('uk-icon-warning');
    });

    view.addEventListener('ended', () => {
        root.classList.remove('w-icon-loading');
        root.classList.add('uk-icon-warning');
    });

    let setURL = (url) => {
        view.src = url;
        view.play();
    };

    return { view, setURL };
};


let wsc_init_chat = (root) => {
    let log = root.querySelector('.log');
    let msg = log.querySelector('.message');
    let rpc = null;
    msg.remove();

    let onLoad = (socket) => {
        rpc = socket;
        root.classList.add('active');
    };

    let onUnload = () => {
        rpc = null;
        root.classList.remove('active');
    };

    let onMessage = (name, text) => {
        let entry = msg.cloneNode(true);
        entry.querySelector('.name').textContent = name;
        entry.querySelector('.text').textContent = text;
        log.appendChild(entry);
    };

    let form = root.querySelector('.input-form');
    let text = form.querySelector('.input');

    text.addEventListener('keydown', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ? ev.preventDefault() : null));

    text.addEventListener('keyup', (ev) =>
        (ev.keyCode === 13 && !ev.shiftKey ? form.dispatchEvent(new Event('submit')) : null));

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        // TODO a real RPC call
        rpc.send(text.value);
        text.value = '';
        text.focus();
    });

    let lform = root.querySelector('.login-form');
    let login = lform.querySelector('.input');

    lform.addEventListener('submit', (ev) => {
        ev.preventDefault();
        // TODO a real RPC call
        rpc.send(login.value);
        lform.remove();
        text.focus();
    });

    return { onLoad, onUnload, onMessage };
};


(() => {
    let stream = document.body.getAttribute('data-stream-id');
    let view = wsc_init_view(document.querySelector('.w-view-container'));
    let chat = wsc_init_chat(document.querySelector('.w-chat-container'));
    let socket = new WebSocket(`ws${window.location.protocol == 'https:' ? 's' : ''}://`
                               + `${window.location.host}/stream/${stream}`);

    socket.onopen = () => {
        // TODO measure connection speed, request a stream
        view.setURL(`/stream/${stream}`);
        chat.onLoad(socket);
    };

    socket.onerror = (ev) => {
        // TODO something?
    };

    socket.onclose = (ev) => {
        // TODO something else
        chat.onUnload();
    };

    socket.onmessage = (ev) => {
        var data = JSON.parse(ev.data);
        // TODO parse RPC messages
        chat.onMessage(data.name, data.message);
    };
})();
