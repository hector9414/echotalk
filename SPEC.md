# EchoTalk — App de interpretación simultánea para audiencias (v1)

## Contexto

EchoTalk es una app web que permite a un orador dar una charla en un idioma, mientras una audiencia presente en la sala la recibe traducida en tiempo real (subtítulos + voz) en sus propios teléfonos. Los oyentes se conectan por WiFi local a un servidor que corre en la laptop del presentador — sin instalar nada. Pensado para un evento puntual (charla, presentación), no para uso continuo tipo SaaS: sin cuentas, sin guardar nada.

Esta especificación se escribió tras una entrevista de requisitos con el usuario (modo de uso, plataforma, salida, persistencia, mecanismo de distribución, idiomas, proveedor de IA y su costo real, y arquitectura de proveedor intercambiable), más investigación técnica dedicada de los límites reales de las APIs de Google Cloud involucradas.

## Decisiones de producto confirmadas

1. **Caso de uso**: un orador → muchos oyentes (no conversación, no llamada remota). Modo "intérprete para audiencia".
2. **Plataforma**: web app, sin build step de frontend, mobile-friendly (los oyentes usan su navegador de celular).
3. **Distribución**: servidor local en la laptop del presentador; los oyentes se conectan por WiFi a la IP LAN. Se deja la puerta abierta (no se construye ahora) para un futuro puente hacia Microsoft Teams.
4. **Salida**: texto (subtítulos en vivo) + voz (texto-a-voz), ambos.
5. **Idiomas destino**: un solo idioma para todos los oyentes por sesión (no selección individual).
6. **Idioma origen**: fijo, seleccionado por el presentador al iniciar la sesión (sin detección automática, sin cambio en caliente).
7. **Persistencia**: ninguna. Todo en memoria, sin cuentas, sin base de datos. Reiniciar el servidor borra todo.
8. **Proveedor de IA**: Google Cloud (Speech-to-Text streaming + Cloud Translation + Text-to-Speech), elegido explícitamente sobre la alternativa gratuita/local tras revisar costos reales (~$2-3 USD/hora en las nubes evaluadas).
9. **Arquitectura de proveedor**: interfaz intercambiable de motor de voz/traducción. La v1 construye solo Google Cloud; más tarde se agregó ElevenLabs como motor de voz alternativo, y después un proveedor local/gratis (whisper.cpp + LibreTranslate + Piper, corriendo como procesos que el usuario administra por su cuenta) tras evaluar costo/complejidad — ver "Abstracción de proveedor" y "Proveedor local" abajo. Tiene una limitación real importante: sin streaming nativo, los subtítulos salen por bloques en vez de palabra por palabra.
10. **HTTPS para el presentador y la audiencia**: agregado para permitir que el presentador use un dispositivo distinto al que corre el servidor (ej. su celular, si esa máquina no tiene micrófono) y, más adelante, para que la audiencia pueda preguntar con su propio micrófono — ver "Hallazgo técnico clave" y "Preguntas del público" abajo.
11. **Preguntas del público**: un oyente a la vez puede pedir la palabra, hablar en su propio idioma (elegido al unirse) y que su pregunta, ya traducida, le llegue **solo al presentador** (no al resto de la audiencia). El presentador responde normalmente con su propio micrófono, y esa respuesta sí sale por el canal principal a todos como siempre.

## Arquitectura técnica

### Stack

- **Backend**: Node.js LTS + TypeScript, Express (estáticos + REST).
- **WebSockets**: librería `ws` (no Socket.IO) — no hay necesidad de escalar a múltiples instancias ni de fallback a long-polling en una LAN con navegadores modernos, y `ws` entrega los frames binarios de audio del micrófono sin overhead de serialización. Dos endpoints sobre el mismo `http.Server`: `/ws/presenter` (control JSON + audio binario mezclado) y `/ws/listen` (broadcast a oyentes).
- **Frontend**: HTML/CSS/JS plano servido como estático — solo 2 pantallas (panel del presentador y vista del oyente), sin framework/bundler.
- **Mismo origen**: presentador y oyentes se sirven desde el mismo Express, sin CORS.
- **HTTPS (autofirmado) por defecto para presentador y audiencia** — necesario para que cualquiera pueda usar su propio micrófono (el presentador desde otro dispositivo, o un oyente para preguntar) — ver "Contexto seguro" abajo. Sin HTTPS para exponer la app fuera de la LAN; sigue siendo una app de red local.
- **SDKs de Google**: `@google-cloud/speech` (v1, streaming), `@google-cloud/translate` (v2 Basic), `@google-cloud/text-to-speech`.
- **Utilidades**: `qrcode`, `dotenv`. `crypto.randomUUID()`/`crypto.randomInt()` nativos de Node.

### Hallazgo técnico clave: contexto seguro del navegador

`getUserMedia` (captura de micrófono) solo funciona en HTTPS o en el caso especial de `localhost`/`127.0.0.1` — una IP LAN por HTTP plano no califica.

Esto tiene dos resoluciones válidas, según en qué dispositivo esté el micrófono real:

1. **El presentador usa la misma laptop que corre el servidor**: abre el panel vía `http://localhost:<puerto>/presenter` (HTTP plano, sin advertencias). Esto es lo más simple cuando aplica.
2. **El presentador usa OTRO dispositivo** (ej. su celular, porque la máquina del servidor no tiene micrófono): `localhost` no es alcanzable desde otro dispositivo, así que se necesita HTTPS real. El servidor levanta un segundo listener HTTPS (`src/tls.ts` + `ENABLE_HTTPS`/`HTTPS_PORT`, activado por defecto) con un **certificado autofirmado generado en memoria en cada arranque** (nunca se escribe a disco), con SAN cubriendo `localhost`, `127.0.0.1` y cada IP LAN detectada. El navegador muestra una advertencia de "conexión no privada" (esperada e inevitable para un certificado no emitido por una autoridad reconocida) que el presentador acepta una vez; después de eso, HTTPS cuenta como contexto seguro y el micrófono del otro dispositivo funciona con normalidad.

**Actualización (preguntas del público)**: dado que un oyente también puede usar su propio micrófono para preguntar (ver "Preguntas del público" abajo), la URL de audiencia que se imprime/codifica en el QR ahora es **HTTPS por defecto** (`buildListenerHttpsUrl`), no HTTP — así cualquiera puede preguntar sin tener que cambiar de URL a mitad del evento. Esto significa que todos los oyentes ven la advertencia de certificado una vez al unirse, no solo quien pregunte; se prefirió consistencia sobre evitarle la advertencia a la mayoría que solo escucha. Con `ENABLE_HTTPS=false`, la audiencia vuelve a HTTP plano y nadie (ni el presentador desde otro dispositivo ni el público) puede usar su micrófono — solo queda disponible el presentador por `localhost`.

### Abstracción de proveedor (Google por defecto, ElevenLabs para voz, local sin nube)

```ts
// src/providers/types.ts
interface SpeechRecognizer {
  write(chunk: Buffer): void;
  stop(): void;
  // emite resultados vía callbacks: onInterim(text), onFinal(text), onError(err)
}
interface Translator {
  translate(text: string, from: string, to: string): Promise<string>;
}
interface SpeechSynthesizer {
  synthesize(text: string, languageCode: string): Promise<{ buffer: Buffer; mime: string }>;
}
interface TranslationProvider {
  createRecognizer(handlers): SpeechRecognizer;
  translator: Translator;
  synthesizer: SpeechSynthesizer;
}
```

`src/providers/google/` implementa esta interfaz con las 3 APIs de Google; `src/providers/local/` la implementa con un stack gratis/sin nube (ver "Proveedor local" abajo). `src/providers/index.ts` es una factory (`createProvider(name: 'google' | 'local', ttsProviderName: 'google' | 'elevenlabs' | 'piper')`) seleccionada por `PROVIDER` y `TTS_PROVIDER` en `.env`. El resto del pipeline depende solo de la interfaz, nunca de las clases concretas de un proveedor.

**Voz intercambiable por separado**: `TTS_PROVIDER=elevenlabs` (`src/providers/elevenlabs/tts.ts`) reemplaza solo el `SpeechSynthesizer`, dejando STT y traducción en Google — es la única combinación mixta soportada hoy, porque ElevenLabs es fuerte específicamente en calidad de voz, no en reconocimiento ni traducción. A diferencia de Google (una voz por idioma, vía `LanguageOption.ttsVoiceName`), los modelos multilingües de ElevenLabs infieren el idioma del texto y hablan todos los idiomas configurados con una sola voz (`ELEVENLABS_VOICE_ID`) — por eso `languageCode`/`voiceName` llegan a `ElevenLabsSpeechSynthesizer.synthesize()` pero se ignoran a propósito. Si faltan `ELEVENLABS_API_KEY` o `ELEVENLABS_VOICE_ID` con `TTS_PROVIDER=elevenlabs`, el servidor falla al arrancar con un error explícito en vez de arrancar a medias.

**Comparación de costo de voz** (~50.000 caracteres/hora, estimado de habla continua traducida; precios de noviembre 2026, confirmar antes de decidir ya que varían con frecuencia):

| Motor | Precio | Costo/hora aprox. |
|---|---|---|
| Google Standard/WaveNet (el que usa esta app sin configurar nada) | $4 / 1M caracteres | $0.20 |
| Google Neural2 | $16 / 1M caracteres | $0.80 |
| Google Chirp 3: HD | $30 / 1M caracteres | $1.50 |
| ElevenLabs Flash/Turbo (modelo rápido) | ~$0.04 / 1K caracteres | ~$2.00 |
| ElevenLabs Multilingual v2/v3/v4 (máxima calidad) | ~$0.08–0.10 / 1K caracteres | ~$4.00–5.00 |

ElevenLabs sale entre 2.5x y 25x más caro que Google según la voz de Google con la que se compare — el salto de calidad de voz tiene un costo real y creciente con el uso. ElevenLabs también ofrece planes mensuales con créditos incluidos que pueden convenir más que pago-por-uso si se prueba con frecuencia.

### Proveedor local (`PROVIDER=local`): sin nube, $0 de API, pero con peor latencia/calidad

Implementado en `src/providers/local/` tras evaluar el costo/complejidad real (investigación de noviembre 2026, antes de construirlo). Las tres piezas son procesos que **el usuario instala y corre por su cuenta** — esta app nunca los descarga, instala ni administra, igual que nunca instala el SDK de Google Cloud:

- **STT**: un servidor compatible con `whisper.cpp` (`examples/server`, ej. `./server -m ggml-base.bin --port 8178`). `LocalSttStreamManager` le hace `POST /inference` con el audio acumulado como WAV.
- **Traducción**: un servidor LibreTranslate (`libretranslate --port 5000`). `LocalTranslator` le hace `POST /translate` (`{q, source, target}` → `{translatedText}`).
- **Voz**: el binario de Piper (ahora mantenido por Open Home Foundation en `OHF-Voice/piper1-gpl`), invocado como subproceso por utterance (`--model <voz>.onnx --output_file -`, texto por stdin, WAV por stdout) — requiere un archivo `<languageId>.onnx` por idioma en `PIPER_MODEL_DIR` (convención de nombre, no autodescarga).

**Por qué no es streaming real (la limitación más importante)**: a diferencia de `streamingRecognize` de Google, los motores basados en Whisper no emiten resultados parciales nativos — transcriben un buffer de audio completo y devuelven un solo resultado. `LocalSttStreamManager` *simula* streaming: acumula el audio de la frase en curso, re-transcribe todo el buffer cada `LOCAL_STT_CHUNK_INTERVAL_MS` (default 2s) como subtítulo "interino", y finaliza (limpia el buffer, dispara traducción+voz) cuando detecta `LOCAL_STT_SILENCE_MS` (default 800ms) de energía por debajo de `LOCAL_STT_SILENCE_RMS_THRESHOLD` vía un cálculo de RMS simple sobre el PCM16 — no hay VAD real, así que el umbral puede necesitar ajuste según el micrófono/ambiente. El resultado: subtítulos que aparecen **por bloques de ~2 segundos**, no palabra por palabra como con Google — una degradación real de la experiencia central de la app, no un detalle cosmético.

**Mapeo de idiomas**: Whisper espera códigos de 2 letras (`en`, `es`) en vez de los códigos BCP-47/Google-específicos de `LANGUAGES` (`en-US`, o `cmn-Hans-CN` para chino) — `toWhisperLanguage()` en `sttStream.ts` deriva el prefijo de 2 letras con una tabla pequeña de excepciones (hoy solo chino). Es una limitación conocida, no una cobertura exhaustiva de todos los códigos especiales de Google.

**Instalación**: `scripts/setup-local-provider.sh` automatiza la descarga/compilación/instalación de las tres piezas (compila whisper.cpp, instala LibreTranslate y Piper en venvs de Python propios, descarga el modelo y las voces) — todo queda en `./local-provider/` (en `.gitignore`, nunca se versiona). Se evaluó incorporar los binarios/modelos directamente al repositorio y se descartó: LibreTranslate no es un binario sino un servicio Python con dependencias de ML, los modelos superan o se acercan al límite de 100MB de GitHub sin Git LFS, y cada modelo/voz tiene su propia licencia de redistribución que habría que auditar una por una.

**Costo real**: $0 en facturación de API, pero el cómputo se traslada a la máquina del presentador — STT es la pieza más pesada (CPU decente o GPU para baja latencia; con solo CPU, los modelos pequeños de Whisper son los únicos cercanos a tiempo real, con menor precisión). Traducción y Piper son livianos, corren bien en CPU. Tampoco hay descarga automática de modelos: Whisper (cientos de MB a ~3GB), paquetes de idioma de LibreTranslate (~50-200MB por par) y voces de Piper (~50-100MB cada una) se instalan aparte, con internet, antes del evento — rompe la promesa de "clona y corre" que sí cumple el proveedor Google.

**Cuándo tiene sentido**: eventos sin internet disponible en el lugar, o cuando el costo de Google (~$2-3 USD/hora) es inaceptable pese a la degradación de calidad. Para la mayoría de casos con internet disponible, Google sigue siendo la opción recomendada — ver la comparación de costos arriba.

### Pipeline de audio en tiempo real

**Captura (navegador del presentador)**: `getUserMedia` (mono, echo cancellation/noise suppression/AGC) → `AudioContext({sampleRate: 16000})` → **AudioWorklet** (no `MediaRecorder`: WebM/Opus solo mete la cabecera del contenedor en el primer blob, lo que complica reiniciar el stream de STT a mitad de charla; PCM crudo no tiene ese problema) → PCM16 en bloques de ~100-200ms → WebSocket binario al servidor.

**STT streaming (Google Cloud)**: `streamingRecognize` con `encoding: LINEAR16, sampleRateHertz: 16000, languageCode: <origen>, interimResults: true`. Resultados interinos actualizan el segmento en curso; el resultado final dispara traducción + voz.

**Reinicio del stream (límite real de Google: 5 min por stream, 10MB total, 25KB por mensaje)**: `SttStreamManager` reinicia el stream cada 4 minutos, con un ring buffer de ~2s de PCM para "recalentar" el stream nuevo antes de redirigir el audio en vivo — invisible para el navegador del presentador. Un contador `seq` monotónico en el servidor garantiza el orden de los segmentos a través de los reinicios.

**Traducción y voz**: al finalizar un segmento, `Translator.translate()` seguido de `Synthesizer.synthesize()` (`audioEncoding: MP3`, el más compatible entre iOS Safari y Android). **Los resultados interinos NO se traducen ni se sintetizan** (evita re-traducir la misma frase creciente varias veces por segundo y subtítulos parpadeantes); el oyente ve un indicador "transcribiendo…" mientras tanto, y el subtítulo/audio real aparece al finalizar el segmento.

Los 3 servicios de Google usan formatos de código de idioma distintos (STT/TTS: BCP-47 tipo `es-ES`; Translation v2: ISO 639-1 tipo `es`) — los idiomas soportados viven en una tabla curada (`LanguageOption`), nunca como texto libre.

**Distribución**: el audio TTS se guarda en memoria (`Map<segmentId, buffer>`) servido vía `GET /api/audio/:id`; el WebSocket a oyentes solo manda la URL (no el binario embebido).

**Reproducción en el oyente**: un único elemento `<audio>` reutilizado con una cola FIFO de clips. La vista de oyente exige un botón "Unirme" (gesto de usuario) que abre el WS y "ceba" el audio.

### Pausar / reanudar

El presentador puede pausar la sesión (ej. una pregunta y respuesta, un video, un receso) sin terminarla: `pause_session` cierra el stream de STT activo (misma mecánica que un reinicio programado, pero sin abrir uno nuevo) y el navegador del presentador deja de enviar frames de audio — nada se transcribe ni se factura mientras está en pausa. El `Session.id`, el historial de segmentos y las conexiones de los oyentes se mantienen intactos; los oyentes ven un indicador de "en pausa" pero conservan el subtítulo/scroll-back previo. `resume_session` abre un stream de STT nuevo y continúa el contador `seq` donde iba. A diferencia de `stop_session`, pausar/reanudar no requiere volver a elegir idiomas ni hace que los oyentes se reconecten.

### Preguntas del público

Un oyente a la vez puede "pedir la palabra" (`src/ws/questionFloor.ts`, usado por `ListenerHub`): elige su propio idioma al conectarse (dropdown igual al de idiomas del presentador), toca "Preguntar", concede permiso de micrófono (por eso toda la audiencia entra por HTTPS por defecto — ver "Hallazgo técnico clave"), y el servidor abre un `SpeechRecognizer` adicional en su idioma usando el mismo `TranslationProvider` de la sesión. Cada frase finalizada se traduce al idioma del presentador (`sourceLanguage` de la sesión, no el `targetLanguage` de la audiencia) y se envía **solo al presentador** (`audience_question`, nunca al resto de oyentes) — no pasa por `SessionManager` ni genera `TranscriptSegment`s, es un canal lateral efímero separado del pipeline principal.

Mientras alguien tiene la palabra, el servidor difunde `question_floor_busy` a todos los oyentes (deshabilita su botón "Preguntar"); al terminar (`end_question` explícito, desconexión del que pregunta, o fin de la sesión) difunde `question_floor_free`. Solo un "piso" (floor) activo a la vez — evita streams de STT simultáneos y audio superpuesto. El presentador responde la pregunta con su propio micrófono de forma normal; esa respuesta sale por el pipeline principal a toda la audiencia, como cualquier otra frase.

### Control de acceso del presentador

PIN numérico de 6 dígitos generado al arrancar el servidor (solo visible en la terminal), intercambiado por un token opaco guardado en `sessionStorage`. La vista de oyente no requiere PIN — tampoco para pedir la palabra y preguntar (cualquiera en la LAN puede hacerlo, limitado únicamente por el turno único). Solo la conexión de presentador que inició la sesión activa puede enviar audio del canal principal.

### Descubribilidad para la audiencia

Al arrancar, el servidor imprime todas las IPs LAN detectadas + genera un QR apuntando a `http://<ip-lan>:<puerto>/`. La URL del presentador por `localhost` se muestra por separado, junto con la(s) URL(s) HTTPS (`https://<ip-lan>:<puerto-https>/presenter`) para cuando el presentador va a usar otro dispositivo (ver "Hallazgo técnico clave" arriba).

## Modelo de datos y CRUD por entidad

Todo en memoria de proceso — nada se persiste a disco.

```ts
type SessionStatus = 'idle' | 'live' | 'paused';
interface Session {
  id: string; status: SessionStatus;
  sourceLanguage: string; targetLanguage: string;
  startedAt: number | null; listenerCount: number;
}
interface TranscriptSegment {
  id: string; seq: number;
  sourceText: string;
  translatedText: string | null;
  audioUrl: string | null;
  isFinal: boolean; updatedAt: number;
}
```

- **Session** (singleton en memoria):
  - *Create*: `start_session {sourceLanguage, targetLanguage}` por WS (requiere token). Valida contra la tabla de idiomas, rechaza si ya hay sesión `live`/`paused`.
  - *Read*: `GET /api/session/status` (REST, público) + push `session_state` a presentador y oyentes.
  - *Update*: `pause_session` / `resume_session` (WS, requiere token) alternan entre `live` y `paused` — sí existe edición en caliente, pero solo para pausar/reanudar. Cambiar de idioma sigue sin poder hacerse en caliente: requiere `stop_session` + `start_session`.
  - *Delete*: `stop_session` (WS, requiere token) — limpia todo el estado en memoria, notifica `session_ended`.
- **TranscriptSegment**:
  - *Create*: generado internamente por el pipeline — no es una acción de usuario.
  - *Read*: broadcast en vivo (`segment_update` / `segment_final`); scroll-back acotado (~50 líneas) solo en el navegador del oyente.
  - *Update*: mensajes `segment_update` sucesivos con el mismo `id` mientras `isFinal=false`.
  - *Delete*: se descartan al `stop_session`; límite defensivo de ~200 segmentos en memoria.
- **Conexión de oyente** (WebSocket, sin autenticación):
  - *Create/Read*: se agrega a un mapa de conexiones activas; `listenerCount` se empuja (con debounce) al presentador.
  - *Update*: no aplica.
  - *Delete*: se remueve al cerrar/perder la conexión.
- **Question floor** (singleton efímero, un asker a la vez - no es una entidad persistida ni parte de `Session`):
  - *Create*: `request_question {language}` por WS de un oyente (sin autenticación) — rechaza si la sesión está `idle`, si el idioma es inválido, o si ya hay alguien preguntando (`question_denied`); si no, concede (`question_granted`) y abre un `SpeechRecognizer` en el idioma del oyente.
  - *Read*: cada frase finalizada se traduce y se envía **solo al presentador** (`audience_question`); el resto de la audiencia solo ve `question_floor_busy`/`question_floor_free` (sin contenido de la pregunta).
  - *Update*: no aplica — no hay edición de una pregunta en curso, solo existe/no existe.
  - *Delete*: `end_question` del propio asker, su desconexión, o el fin de la sesión — todos liberan el floor (`question_floor_free`) y detienen el `SpeechRecognizer`.

## Estructura de archivos

```
echotalk/
  package.json  tsconfig.json  .env.example  README.md  SPEC.md
  src/
    server.ts                 # entrypoint: banner de arranque + listen(), llama a buildApp()
    app.ts                    # composicion pura de la app (Express+WS+pipeline), sin listen() - testeable
    config.ts                 # env, tabla curada de LanguageOption, constantes
    types.ts                  # Session, TranscriptSegment, mensajes WS, LanguageOption
    auth.ts                   # PIN + token
    sessionManager.ts         # singleton Session + segmentos en memoria
    audioStore.ts             # Map<id,{buffer,mime}> de clips TTS
    pipeline.ts               # orquesta STT -> translate+TTS -> broadcast
    providers/
      types.ts
      index.ts                # factory createProvider('google'|'local', 'google'|'elevenlabs'|'piper')
      google/
        speechStream.ts       # SttStreamManager
        translate.ts
        tts.ts
      elevenlabs/
        tts.ts                # SpeechSynthesizer alterno, seleccionable con TTS_PROVIDER=elevenlabs
      local/                  # proveedor gratis/sin nube (PROVIDER=local) - ver "Proveedor local"
        sttStream.ts          # chunking+VAD simple sobre un servidor whisper.cpp (sin streaming nativo)
        translator.ts         # fetch a un servidor LibreTranslate
        tts.ts                # subproceso de Piper por utterance
        wav.ts                # envuelve PCM16 crudo en un header WAV para subirlo al servidor de STT
    ws/
      presenterSocket.ts
      listenerSocket.ts
      questionFloor.ts          # turno unico de "pedir la palabra" para preguntas del publico
    routes.ts
    network.ts
    tls.ts                    # genera el certificado autofirmado para el servidor HTTPS
  public/
    presenter/  {index.html, presenter.css, presenter.js}
    listen/     {index.html, listen.css, listen.js}
    shared/pcm-worklet.js
```

## Fuera de alcance (v1)

Cuentas de usuario · persistencia/historial de transcripciones · multi-sesión simultánea · selección de idioma **de recepción** por oyente individual (el idioma que cada oyente elige al unirse es solo para si pregunta, no cambia en qué idioma recibe la interpretación principal, que sigue siendo uno solo por sesión) · integración real con Teams (solo manual, ver README.md) · streaming nativo de STT en el proveedor local (simulado por bloques, ver "Proveedor local") · descarga/instalación automática de los modelos del proveedor local (Whisper/LibreTranslate/Piper - el usuario los instala aparte) · app móvil nativa · acceso remoto fuera de la LAN (el HTTPS que sí existe es solo para el contexto seguro del micrófono dentro de la red local, no para exponer la app a internet) · certificado HTTPS confiable/de una autoridad reconocida (es autofirmado a propósito) · cambio de idioma en caliente · varias preguntas simultáneas (un piso, un asker a la vez) · que la pregunta traducida llegue a la audiencia (solo al presentador).

## Riesgos y limitaciones conocidas

- Palabra pronunciada justo en el instante de un reinicio de stream STT: mitigado con el ring buffer de replay, no eliminado al 100%.
- Un presentador que hable muy corrido podría generar un segmento cerca del límite de 5.000 bytes por request de TTS — partición defensiva en oraciones si el texto traducido supera ~4.500 bytes.
- Si el WiFi del lugar pierde salida a internet con `PROVIDER=google`, todo el pipeline se detiene. `PROVIDER=local` no depende de internet durante el evento, pero sí durante la instalación inicial (descarga de modelos) y tiene subtítulos por bloques en vez de palabra por palabra - ver "Proveedor local".
- Aislamiento de clientes en redes WiFi de invitados impediría que los oyentes alcancen el servidor — riesgo de infraestructura del lugar.
- Un AP doméstico soporta confiablemente ~30-50 clientes; escalar a "un par de cientos" de oyentes requiere un AP de nivel empresarial.
- iOS Safari puede pausar el audio si el oyente bloquea la pantalla.
- Nada detiene automáticamente una sesión olvidada salvo la desconexión del presentador.

## Tests automatizados

`npm test` corre la suite (node:test + tsx, sin dependencias extra) sobre todo lo que no requiere credenciales reales ni un navegador: ciclo de vida de `SessionManager` (incluyendo pausar/reanudar), `TranslationPipeline` con un proveedor falso, los wrappers de Google (`translate.ts`/`tts.ts`/`speechStream.ts`, incluyendo el reinicio del stream tras un error), de ElevenLabs (`elevenlabs/tts.ts`, con `fetch` inyectado) y del proveedor local (`local/sttStream.ts`, `local/translator.ts`, `local/tts.ts`, `local/wav.ts` - con `fetch`/subproceso inyectados, incluyendo el chunking+VAD simulado y la cola de un "final" pendiente mientras un "interino" está en vuelo) con un cliente/fetch/proceso falso, la generación del certificado autofirmado (`tls.ts`), el turno único de preguntas (`questionFloor.ts`: conceder/denegar, traducción, liberación), las rutas REST contra un servidor real en un puerto efímero, y el cableado completo de WebSockets (`app.ts`) incluyendo el ciclo start/pausar/reanudar/detener y el flujo completo de preguntas del público (conceder/denegar/liberar, también al terminar la sesión) de punta a punta **sobre HTTP y sobre HTTPS**. Fuera de alcance de esta suite: el frontend/AudioWorklet (no testeable sin navegador) y el pipeline de audio real contra APIs/servidores reales (requiere credenciales, micrófono y/o los procesos locales corriendo) - ambos cubiertos por la verificación manual de abajo.

**Notas de diseño de tests**:
- Los tests de WebSocket que esperan un mensaje de *broadcast* disparado por la acción de OTRO socket deben registrar ese `waitForMessage` **antes** de disparar la acción (guardar la promesa, disparar, luego esperarla) — si el broadcast no tiene ninguna espera asíncrona de por medio en el servidor, puede llegar y perderse antes de que el test esté escuchando, colgando el test indefinidamente en vez de fallar con un timeout. Ver el comentario sobre `waitForMessage` en `app.test.ts`.
- Cualquier clase de test que arranque un `setInterval`/`setTimeout` propio (ej. `LocalSttStreamManager`) debe llamar su `stop()` dentro de un `finally`, no solo al final feliz del test — si una aserción falla antes de llegar al `stop()`, el temporizador queda vivo para siempre y cuelga **todo el proceso de test**, no solo ese test (mismo síntoma que el bug de arriba: baja carga de CPU, el proceso nunca termina). Ver el helper `withManager()` en `local/sttStream.test.ts`.

## Verificación end-to-end

1. Habilitar en el proyecto de Google Cloud: Speech-to-Text, Cloud Translation, Text-to-Speech. Autenticar localmente (`gcloud auth application-default login` o service account + `GOOGLE_APPLICATION_CREDENTIALS`).
2. `npm install` → `npm run dev` → confirmar que la terminal imprime PIN, URL de presentador (`localhost`) y URL(es) LAN de oyentes + QR.
3. Abrir el panel vía `localhost`, ingresar PIN, elegir idiomas (default es-ES→en-US), iniciar sesión, conceder permiso de mic. Confirmar que abrir el panel vía la IP LAN **por HTTP** falla el permiso de micrófono.
3b. Probar el flujo de "presentador en otro dispositivo": desde un celular en la misma WiFi, abrir la URL `https://<ip-lan>:<puerto-https>/presenter`, aceptar la advertencia de certificado autofirmado, ingresar el PIN y confirmar que el micrófono del celular sí funciona (a diferencia del paso 3, aquí SÍ debe pedir/conceder permiso con normalidad por ser HTTPS).
4. Desde un segundo dispositivo en la misma WiFi: escanear el QR, tocar "Unirme", hablar frente al mic del presentador. Confirmar indicador interino, subtítulo final traducido, audio reproducido, segmentos en orden.
5. Confirmar que el contador de oyentes sube/baja al conectar/desconectar dispositivos.
6. Sesión larga (10-15+ min) para cruzar 2-3 reinicios de stream STT; confirmar que no hay corte perceptible.
7. Cortar el WiFi del presentador unos segundos: confirmar estado `reconnecting`/`error` y recuperación automática.
8. Detener sesión: oyentes reciben aviso de fin, una nueva sesión arranca limpia.
9. Reconexión de un oyente (modo avión o recarga de pestaña) durante una sesión viva.
10. PIN incorrecto rechazado sin filtrar información.
11. **Preguntas del público**: en la vista de oyente, elegir un idioma distinto al de la charla, tocar "Preguntar", conceder el permiso de micrófono (confirma que HTTPS para la audiencia habilita esto), hablar una pregunta corta. Confirmar que: (a) el botón "Preguntar" se deshabilita en los demás oyentes mientras tanto, (b) la pregunta traducida aparece en el panel del presentador y NO en la vista de los demás oyentes, (c) tocar "Terminar pregunta" libera el turno y reactiva el botón para todos, (d) un segundo oyente que intenta preguntar mientras el primero tiene la palabra recibe un mensaje de "otra persona está preguntando".
12. **Proveedor local** (`PROVIDER=local`): con el servidor whisper.cpp, LibreTranslate y los modelos de Piper corriendo (ver README.md), repetir el paso 4 y confirmar que: (a) el subtítulo "interino" aparece por bloques cada `LOCAL_STT_CHUNK_INTERVAL_MS` en vez de palabra por palabra, (b) el segmento se finaliza al hacer una pausa al hablar (ajustar `LOCAL_STT_SILENCE_RMS_THRESHOLD` si no detecta el silencio o corta a mitad de frase), (c) la traducción y la voz sintetizada igual llegan a los oyentes, con calidad perceptiblemente menor que con Google.
