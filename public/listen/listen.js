(() => {
  const state = {
    ws: null,
    audioEl: null,
    queue: [],
    playing: false,
  };

  const el = (id) => document.getElementById(id);

  const SESSION_STATUS_LABEL = {
    idle: 'Esperando a que el presentador inicie la sesión...',
    live: 'En vivo',
    paused: 'El presentador puso la sesión en pausa',
  };

  function join() {
    el('join-screen').hidden = true;
    el('listen-screen').hidden = false;

    state.audioEl = el('player');
    state.audioEl.addEventListener('ended', playNextInQueue);

    // Best-effort autoplay unlock: calling play()/pause() synchronously
    // inside this click handler is what lets later programmatic play()
    // calls (once real clips arrive) work without another tap, in most
    // browsers. If a browser still blocks it later, playNextInQueue()
    // falls back to a visible "tap to listen" button.
    const primingAttempt = state.audioEl.play();
    if (primingAttempt && typeof primingAttempt.catch === 'function') {
      primingAttempt.catch(() => {});
    }
    state.audioEl.pause();

    connectWebSocket();
  }

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws/listen`);
    ws.addEventListener('message', (event) => handleServerMessage(JSON.parse(event.data)));
    ws.addEventListener('close', () => {
      setStatusText('Se perdió la conexión. Intenta recargar la página.');
    });
    state.ws = ws;
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case 'session_state':
        setStatusText(SESSION_STATUS_LABEL[message.session.status] || message.session.status);
        break;
      case 'segment_update':
        renderCaptionLine(message.segment);
        break;
      case 'segment_final':
        renderCaptionLine(message.segment);
        if (message.segment.audioUrl) enqueueAudio(message.segment.audioUrl);
        break;
      case 'session_ended':
        setStatusText('La sesión terminó. Gracias por escuchar.');
        break;
      default:
        break;
    }
  }

  function setStatusText(text) {
    el('session-status').textContent = text;
  }

  function renderCaptionLine(segment) {
    const list = el('captions');
    let line = document.getElementById(`cap-${segment.id}`);
    if (!line) {
      line = document.createElement('p');
      line.id = `cap-${segment.id}`;
      line.className = 'caption-line';
      list.appendChild(line);
    }
    line.textContent = segment.translatedText || 'Transcribiendo…';
    line.classList.toggle('pending', !segment.isFinal);
    list.scrollTop = list.scrollHeight;
    while (list.children.length > 50) {
      list.removeChild(list.firstChild);
    }
  }

  function enqueueAudio(url) {
    state.queue.push(url);
    if (!state.playing) playNextInQueue();
  }

  function playNextInQueue() {
    const next = state.queue.shift();
    if (!next) {
      state.playing = false;
      return;
    }
    state.playing = true;
    state.audioEl.src = next;
    const playAttempt = state.audioEl.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => showResumeButton());
    }
  }

  function showResumeButton() {
    const button = el('resume-audio');
    button.hidden = false;
    button.onclick = () => {
      button.hidden = true;
      state.audioEl.play().catch(() => {});
    };
  }

  el('join-button').addEventListener('click', join);
})();
