(() => {
  const state = {
    token: null,
    ws: null,
    audioContext: null,
    workletNode: null,
    micStream: null,
  };

  const el = (id) => document.getElementById(id);

  const SESSION_STATUS_LABEL = { idle: 'Detenida', live: 'En vivo', paused: 'En pausa' };
  const STT_STATUS_LABEL = { connected: 'Conectado', reconnecting: 'Reconectando...', error: 'Error' };

  async function loadLanguages() {
    const res = await fetch('/api/languages');
    const languages = await res.json();
    const sourceSelect = el('source-language');
    const targetSelect = el('target-language');
    for (const lang of languages) {
      sourceSelect.add(new Option(lang.label, lang.id));
      targetSelect.add(new Option(lang.label, lang.id));
    }
    if ([...sourceSelect.options].some((o) => o.value === 'es-ES')) sourceSelect.value = 'es-ES';
    if ([...targetSelect.options].some((o) => o.value === 'en-US')) targetSelect.value = 'en-US';
  }

  async function loadNetworkInfo() {
    const res = await fetch('/api/network');
    const info = await res.json();
    const list = el('listener-urls');
    list.innerHTML = '';
    for (const url of info.listenerUrls) {
      const li = document.createElement('li');
      li.textContent = url;
      list.appendChild(li);
    }
    if (info.qrDataUrl) {
      el('qr-image').src = info.qrDataUrl;
      el('qr-image').hidden = false;
    }
  }

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws/presenter`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    });
    ws.addEventListener('message', (event) => handleServerMessage(JSON.parse(event.data)));
    ws.addEventListener('close', () => {
      setStatusMessage('Se perdio la conexion con el servidor. Recarga la pagina.');
    });
    state.ws = ws;
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case 'auth_ok':
        showPanel();
        break;
      case 'auth_failed':
        showLoginError('PIN incorrecto');
        break;
      case 'session_state':
        updateSessionUi(message.session);
        break;
      case 'segment_update':
      case 'segment_final':
        renderTranscriptLine(message.segment);
        break;
      case 'stt_status':
        el('stt-status').textContent = STT_STATUS_LABEL[message.status] || message.status;
        break;
      case 'error':
        setStatusMessage(`Error: ${message.message}`);
        break;
      default:
        break;
    }
  }

  function updateSessionUi(session) {
    el('listener-count').textContent = String(session.listenerCount);
    el('session-status').textContent = SESSION_STATUS_LABEL[session.status] || session.status;

    el('start-button').disabled = session.status !== 'idle';
    el('pause-button').disabled = session.status !== 'live';
    el('resume-button').disabled = session.status !== 'paused';
    el('stop-button').disabled = session.status === 'idle';
    el('source-language').disabled = session.status !== 'idle';
    el('target-language').disabled = session.status !== 'idle';

    if (session.status === 'idle') {
      el('transcript').innerHTML = '';
    }

    if (state.audioContext) {
      if (session.status === 'paused' && state.audioContext.state === 'running') {
        state.audioContext.suspend();
      } else if (session.status === 'live' && state.audioContext.state === 'suspended') {
        state.audioContext.resume();
      }
    }
  }

  function renderTranscriptLine(segment) {
    const list = el('transcript');
    let line = document.getElementById(`seg-${segment.id}`);
    if (!line) {
      line = document.createElement('div');
      line.id = `seg-${segment.id}`;
      line.className = 'transcript-line';
      list.appendChild(line);
    }
    line.textContent = segment.sourceText || '…';
    line.classList.toggle('final', segment.isFinal);

    let translated = line.querySelector('.translated');
    if (segment.isFinal && segment.translatedText) {
      if (!translated) {
        translated = document.createElement('span');
        translated.className = 'translated';
        line.appendChild(translated);
      }
      translated.textContent = segment.translatedText;
    }

    list.scrollTop = list.scrollHeight;
    while (list.children.length > 50) {
      list.removeChild(list.firstChild);
    }
  }

  function setStatusMessage(text) {
    el('status-message').textContent = text;
  }

  function showLoginError(text) {
    el('login-error').textContent = text;
  }

  function showPanel() {
    el('login-screen').hidden = true;
    el('panel-screen').hidden = false;
    loadNetworkInfo();
  }

  async function login(event) {
    event.preventDefault();
    const pin = el('pin-input').value.trim();
    showLoginError('');
    try {
      const res = await fetch('/api/presenter/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        showLoginError('PIN incorrecto');
        return;
      }
      const data = await res.json();
      state.token = data.token;
      connectWebSocket();
    } catch (err) {
      showLoginError('No se pudo conectar con el servidor.');
    }
  }

  async function ensureAudioPipeline() {
    if (state.audioContext) return;
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.audioContext = new AudioContext({ sampleRate: 16000 });
    await state.audioContext.audioWorklet.addModule('/shared/pcm-worklet.js');
    const source = state.audioContext.createMediaStreamSource(state.micStream);
    state.workletNode = new AudioWorkletNode(state.audioContext, 'pcm-worklet-processor');
    state.workletNode.port.onmessage = (event) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(event.data);
      }
    };
    // Deliberately not connected to audioContext.destination: we don't want
    // the presenter's own voice echoed back through their speakers.
    source.connect(state.workletNode);
  }

  async function startSession() {
    try {
      await ensureAudioPipeline();
    } catch (err) {
      setStatusMessage(
        'No se pudo acceder al microfono. Si abriste esta pagina usando una IP en vez de localhost, ' +
          'el navegador bloquea el microfono - usa la URL de localhost que se muestra en la terminal.',
      );
      return;
    }
    setStatusMessage('');
    state.ws.send(
      JSON.stringify({
        type: 'start_session',
        sourceLanguage: el('source-language').value,
        targetLanguage: el('target-language').value,
      }),
    );
  }

  function pauseSession() {
    state.ws.send(JSON.stringify({ type: 'pause_session' }));
  }

  function resumeSession() {
    state.ws.send(JSON.stringify({ type: 'resume_session' }));
  }

  function stopSession() {
    if (state.workletNode) state.workletNode.port.postMessage('flush');
    state.ws.send(JSON.stringify({ type: 'stop_session' }));
  }

  el('login-form').addEventListener('submit', login);
  el('start-button').addEventListener('click', startSession);
  el('pause-button').addEventListener('click', pauseSession);
  el('resume-button').addEventListener('click', resumeSession);
  el('stop-button').addEventListener('click', stopSession);

  loadLanguages();
})();
