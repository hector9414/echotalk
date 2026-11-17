(() => {
  const state = {
    ws: null,
    audioEl: null,
    queue: [],
    playing: false,
    asking: false,
    questionAudioContext: null,
    questionWorkletNode: null,
    questionMicStream: null,
  };

  const el = (id) => document.getElementById(id);

  const SESSION_STATUS_LABEL = {
    idle: 'Esperando a que el presentador inicie la sesión...',
    live: 'En vivo',
    paused: 'El presentador puso la sesión en pausa',
  };

  async function loadLanguages() {
    const res = await fetch('/api/languages');
    const languages = await res.json();
    const select = el('my-language');
    for (const lang of languages) {
      select.add(new Option(lang.label, lang.id));
    }
    if ([...select.options].some((o) => o.value === 'es-ES')) select.value = 'es-ES';
  }

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
      case 'question_granted':
        setAskingUi(true);
        setQuestionStatus('Tienes la palabra - habla ahora.');
        break;
      case 'question_denied':
        teardownQuestionAudioPipeline();
        setQuestionStatus(message.reason);
        break;
      case 'question_floor_busy':
        setFloorBusyUi(true);
        break;
      case 'question_floor_free':
        // Covers both ending normally and a forced release (ej. el
        // presentador detuvo la sesión mientras preguntabas) - siempre es
        // seguro liberar el micrófono propio si seguía abierto.
        if (state.asking) {
          teardownQuestionAudioPipeline();
          setAskingUi(false);
        }
        setFloorBusyUi(false);
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

  // --- Preguntas del público (micrófono propio, un oyente a la vez) ---

  function describeMicError(err) {
    console.error('Fallo al preparar el micrófono para preguntar:', err);
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Permiso de micrófono denegado. Revisa los ajustes de este sitio en tu navegador.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No se detectó ningún micrófono en este dispositivo.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'El micrófono está en uso por otra app. Ciérrala e intenta de nuevo.';
    }
    if (name === 'SecurityError') {
      return 'El navegador bloqueó el micrófono. Entra con la URL https:// (no http://) para poder preguntar.';
    }
    return `No se pudo usar el micrófono (${name || 'error desconocido'}).`;
  }

  async function ensureQuestionAudioPipeline() {
    state.questionMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.questionAudioContext = new AudioContext({ sampleRate: 16000 });
    await state.questionAudioContext.audioWorklet.addModule('/shared/pcm-worklet.js');
    const source = state.questionAudioContext.createMediaStreamSource(state.questionMicStream);
    state.questionWorkletNode = new AudioWorkletNode(state.questionAudioContext, 'pcm-worklet-processor');
    state.questionWorkletNode.port.onmessage = (event) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(event.data);
      }
    };
    source.connect(state.questionWorkletNode);
  }

  function teardownQuestionAudioPipeline() {
    if (state.questionWorkletNode) {
      state.questionWorkletNode.port.postMessage('flush');
      state.questionWorkletNode.disconnect();
      state.questionWorkletNode = null;
    }
    if (state.questionAudioContext) {
      state.questionAudioContext.close();
      state.questionAudioContext = null;
    }
    if (state.questionMicStream) {
      state.questionMicStream.getTracks().forEach((track) => track.stop());
      state.questionMicStream = null;
    }
  }

  async function askQuestion() {
    const language = el('my-language').value;
    if (!language) {
      setQuestionStatus('Elige tu idioma arriba antes de preguntar.');
      return;
    }
    try {
      await ensureQuestionAudioPipeline();
    } catch (err) {
      setQuestionStatus(describeMicError(err));
      return;
    }
    setQuestionStatus('Conectando...');
    state.ws.send(JSON.stringify({ type: 'request_question', language }));
  }

  function endQuestion() {
    teardownQuestionAudioPipeline();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'end_question' }));
    }
    setAskingUi(false);
    setQuestionStatus('');
  }

  function setAskingUi(asking) {
    state.asking = asking;
    el('ask-button').hidden = asking;
    el('end-question-button').hidden = !asking;
  }

  function setFloorBusyUi(busy) {
    if (state.asking) return; // mis propios botones ya reflejan que YO soy quien pregunta
    el('ask-button').disabled = busy;
    setQuestionStatus(busy ? 'Otra persona está preguntando...' : '');
  }

  function setQuestionStatus(text) {
    el('question-status').textContent = text;
  }

  el('join-button').addEventListener('click', join);
  el('ask-button').addEventListener('click', askQuestion);
  el('end-question-button').addEventListener('click', endQuestion);

  loadLanguages();
})();
