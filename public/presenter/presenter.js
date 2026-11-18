(() => {
  const state = {
    token: null,
    ws: null,
    audioContext: null,
    workletNode: null,
    micStream: null,
    questionAudioEl: null,
    questionQueue: [],
    questionPlaying: false,
    micTestStream: null,
    micTestAudioContext: null,
    micTestAnalyser: null,
    micTestRafId: null,
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
      case 'audience_question':
        renderAudienceQuestion(message.question);
        break;
      case 'question_asking_started':
        setAskingBanner(true);
        break;
      case 'question_asking_ended':
        setAskingBanner(false);
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
    el('mic-test-button').disabled = session.status !== 'idle';

    if (session.status === 'idle') {
      el('transcript').innerHTML = '';
      el('questions').innerHTML = '';
      setAskingBanner(false);
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

  function renderAudienceQuestion(question) {
    const list = el('questions');
    const line = document.createElement('div');
    line.className = 'transcript-line final';
    line.textContent = `(${question.sourceLanguageLabel}) ${question.sourceText}`;

    const translated = document.createElement('span');
    translated.className = 'translated';
    translated.textContent = question.translatedText;
    line.appendChild(translated);

    list.appendChild(line);
    list.scrollTop = list.scrollHeight;
    while (list.children.length > 50) {
      list.removeChild(list.firstChild);
    }

    if (question.audioUrl) enqueueQuestionAudio(question.audioUrl);
  }

  function enqueueQuestionAudio(url) {
    state.questionQueue.push(url);
    if (!state.questionPlaying) playNextQuestionAudio();
  }

  function playNextQuestionAudio() {
    const next = state.questionQueue.shift();
    if (!next) {
      state.questionPlaying = false;
      return;
    }
    state.questionPlaying = true;
    state.questionAudioEl.src = next;
    const playAttempt = state.questionAudioEl.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      // Si el navegador bloqueó la reproducción automática (ej. nunca se
      // llegó a loguear, o el bloqueo es más estricto de lo esperado), no
      // hay forma de forzarlo sin otro gesto del usuario - el presentador
      // de todas formas ve el texto de la pregunta en pantalla.
      playAttempt.catch(() => {
        state.questionPlaying = false;
      });
    }
  }

  function setStatusMessage(text) {
    el('status-message').textContent = text;
  }

  // Puramente informativo - nunca pausa/reanuda nada solo. El presentador
  // decide si quiere pausar mientras alguien pregunta o seguir hablando;
  // ver SPEC.md ("Preguntas del público") sobre por qué no se automatiza.
  function setAskingBanner(visible) {
    el('asking-banner').hidden = !visible;
  }

  function showLoginError(text) {
    el('login-error').textContent = text;
  }

  function showPanel() {
    el('login-screen').hidden = true;
    el('panel-screen').hidden = false;
    loadNetworkInfo();
  }

  // Best-effort autoplay unlock, igual que en listen.js: un play()/pause()
  // síncrono dentro de un gesto real del usuario (este submit) es lo que
  // deja que las reproducciones programáticas futuras de la voz de las
  // preguntas del público funcionen sin que el presentador tenga que
  // tocar nada.
  function primeQuestionAudioPlayback() {
    const attempt = state.questionAudioEl.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    state.questionAudioEl.pause();
  }

  async function login(event) {
    event.preventDefault();
    primeQuestionAudioPlayback();
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
    requireMediaDevices();
    state.micStream = await navigator.mediaDevices.getUserMedia({
      // noiseSuppression/autoGainControl deliberately OFF: both can clip the
      // trailing consonants/vowels of a word as its volume fades out,
      // mistaking them for background noise - and since that's the same
      // audio sent to Google STT, the clipped word shows up in the
      // transcript AND the translated voice, not just locally. echoCancellation
      // stays on since it's unrelated to this (it's about feedback, not
      // noise gating) and doesn't cause the same symptom.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
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

  // getUserMedia()/AudioWorklet can fail for several unrelated reasons; a
  // single generic message for all of them makes the real cause hard to find.
  function describeAudioPipelineError(err) {
    console.error('Fallo al preparar la captura de audio:', err);
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return (
        'El navegador bloqueó el permiso de micrófono. Haz clic en el ícono de micrófono/candado ' +
        'en la barra de direcciones, permite el acceso, y vuelve a intentar. Si ya lo habías denegado ' +
        'antes, el navegador puede dejar de preguntar automáticamente - revisa los ajustes del sitio.'
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No se detectó ningún micrófono en este equipo. Verifica que haya uno conectado/habilitado.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return (
        'El micrófono está en uso por otra aplicación (Zoom, Teams, otra pestaña, etc.) o no se pudo ' +
        'iniciar. Cierra lo que lo esté usando e intenta de nuevo.'
      );
    }
    if (name === 'SecurityError') {
      return (
        'El navegador bloqueó el micrófono por seguridad. Si estás en la misma máquina que corre el ' +
        'servidor, usa exactamente http://localhost:<puerto>/presenter (no una IP). Si estás en otro ' +
        'dispositivo (ej. tu celular), usa la URL https:// que se muestra en la terminal del servidor, ' +
        'no la URL http:// de los oyentes.'
      );
    }
    return (
      `No se pudo iniciar la captura de audio (${name || 'error desconocido'}` +
      `${err && err.message ? ': ' + err.message : ''}). Revisa la consola del navegador (F12) para más detalle.`
    );
  }

  // navigator.mediaDevices es undefined por completo en un contexto no
  // seguro (ej. una IP de LAN por HTTP plano) - acceder a .getUserMedia ahí
  // lanza un TypeError genérico, no un SecurityError, así que nunca
  // llegaba al mensaje ya escrito para ese caso. Esta verificación
  // explícita lo redirige al mensaje correcto.
  function requireMediaDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const err = new Error('getUserMedia no está disponible: la página no está en un contexto seguro.');
      err.name = 'SecurityError';
      throw err;
    }
  }

  // Prueba de micrófono independiente de la sesión real: no usa el
  // AudioWorklet ni manda nada al servidor, solo muestra el nivel de audio
  // captado en vivo (vía AnalyserNode) para confirmar que el micrófono
  // funciona antes de iniciar. Usa los mismos ajustes de getUserMedia que
  // la sesión real (ver ensureAudioPipeline) para que el nivel mostrado sea
  // representativo. No hay ningún "umbral" que configurar aquí - Google STT
  // recibe el audio crudo, sin ningún filtro de sensibilidad propio de esta
  // app; esto es solo retroalimentación visual.
  async function toggleMicTest() {
    if (state.micTestStream) {
      stopMicTest();
      return;
    }

    el('mic-test-error').textContent = '';
    try {
      requireMediaDevices();
      state.micTestStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      el('mic-test-error').textContent = describeAudioPipelineError(err);
      return;
    }

    state.micTestAudioContext = new AudioContext();
    const source = state.micTestAudioContext.createMediaStreamSource(state.micTestStream);
    state.micTestAnalyser = state.micTestAudioContext.createAnalyser();
    state.micTestAnalyser.fftSize = 512;
    source.connect(state.micTestAnalyser);

    el('mic-test-button').textContent = 'Detener prueba';
    updateMicMeter();
  }

  function updateMicMeter() {
    const data = new Uint8Array(state.micTestAnalyser.fftSize);
    state.micTestAnalyser.getByteTimeDomainData(data);

    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128; // -1..1
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / data.length); // ~0 (silencio) .. ~1 (muy fuerte)
    const level = Math.min(1, rms * 4); // escalado solo para que se note en la barra

    const fill = el('mic-meter-fill');
    fill.style.width = `${Math.round(level * 100)}%`;
    fill.style.background = level < 0.5 ? '#4caf7d' : level < 0.8 ? '#e0b32e' : '#d64545';

    state.micTestRafId = requestAnimationFrame(updateMicMeter);
  }

  function stopMicTest() {
    if (state.micTestRafId) {
      cancelAnimationFrame(state.micTestRafId);
      state.micTestRafId = null;
    }
    if (state.micTestAudioContext) {
      state.micTestAudioContext.close();
      state.micTestAudioContext = null;
    }
    if (state.micTestStream) {
      state.micTestStream.getTracks().forEach((track) => track.stop());
      state.micTestStream = null;
    }
    state.micTestAnalyser = null;
    el('mic-meter-fill').style.width = '0%';
    el('mic-test-button').textContent = 'Probar micrófono';
  }

  async function startSession() {
    stopMicTest(); // no dejar dos getUserMedia abiertos a la vez
    try {
      await ensureAudioPipeline();
    } catch (err) {
      setStatusMessage(describeAudioPipelineError(err));
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
    // Resume the mic's AudioContext right here, synchronously inside this
    // click handler - NOT only reactively from the session_state message in
    // updateSessionUi(), which runs async from a WebSocket event, not a
    // user gesture. Some browsers (notably mobile Safari) only honor
    // AudioContext.resume() when it's called directly from a real user
    // gesture; calling it later from a message handler can silently fail,
    // leaving the AudioContext suspended - captured audio stops reaching
    // the worklet/WebSocket even though the server thinks the session is
    // live again. This is the most likely explanation for "reanudar deja
    // de captar audio".
    if (state.audioContext && state.audioContext.state === 'suspended') {
      state.audioContext.resume().catch(() => {});
    }
    state.ws.send(JSON.stringify({ type: 'resume_session' }));
  }

  function stopSession() {
    if (state.workletNode) state.workletNode.port.postMessage('flush');
    state.ws.send(JSON.stringify({ type: 'stop_session' }));
  }

  state.questionAudioEl = el('question-player');
  state.questionAudioEl.addEventListener('ended', playNextQuestionAudio);

  el('login-form').addEventListener('submit', login);
  el('start-button').addEventListener('click', startSession);
  el('pause-button').addEventListener('click', pauseSession);
  el('resume-button').addEventListener('click', resumeSession);
  el('stop-button').addEventListener('click', stopSession);
  el('mic-test-button').addEventListener('click', toggleMicTest);

  loadLanguages();
})();
