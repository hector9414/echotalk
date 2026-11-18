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
9. **Arquitectura de proveedor**: interfaz intercambiable de motor de voz/traducción (para poder añadir después un proveedor gratuito/local — faster-whisper + LibreTranslate/Argos + Piper, corriendo como procesos locales), pero **se construye e implementa solo el proveedor Google Cloud en esta versión**. Más tarde se agregó ElevenLabs como motor de voz alternativo (ver "Abstracción de proveedor" abajo).
10. **HTTPS para el presentador y la audiencia**: agregado para permitir que el presentador use un dispositivo distinto al que corre el servidor (ej. su celular, si esa máquina no tiene micrófono) y, más adelante, para que la audiencia pueda preguntar con su propio micrófono — ver "Hallazgo técnico clave" y "Preguntas del público" abajo.
11. **Preguntas del público**: un oyente a la vez puede pedir la palabra, hablar en su propio idioma (elegido al unirse) y que su pregunta, ya traducida (texto **y voz**), le llegue **solo al presentador** (no al resto de la audiencia). El presentador responde normalmente con su propio micrófono, y esa respuesta sí sale por el canal principal a todos como siempre.
12. **Modo discusión (post-presentación)**: tras la charla, se puede abrir un espacio de discusión donde **cualquiera** (cualquier oyente, o el propio operador del panel) pide la palabra por turnos y, al hablar, se traduce y se difunde a **todo el auditorio** (no solo al presentador, a diferencia de "Preguntas del público" arriba) — resuelve el problema de "dar la palabra a cada uno manualmente". Durante este modo no existe un "presentador" con micrófono fijo: todos, incluido el operador, piden la palabra igual. Solo soporta español↔inglés (si quien habla y quien escucha ya comparten el mismo de los dos, no se traduce ni se sintetiza voz — solo se muestra el texto original). Ver "Modo discusión" abajo para el diseño completo.

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

### Abstracción de proveedor (Google por defecto, ElevenLabs para voz, local a futuro)

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

`src/providers/google/` implementa esta interfaz con las 3 APIs de Google. `src/providers/index.ts` es una factory (`createProvider(name: 'google' | 'local', ttsProviderName: 'google' | 'elevenlabs')`) seleccionada por `PROVIDER` y `TTS_PROVIDER` en `.env`; `'local'` queda **declarada pero no implementada**. El resto del pipeline depende solo de la interfaz, nunca de las clases concretas de un proveedor.

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

Un oyente a la vez puede "pedir la palabra" (`src/ws/questionFloor.ts`, usado por `ListenerHub`): elige su propio idioma al conectarse (dropdown igual al de idiomas del presentador), toca "Preguntar", concede permiso de micrófono (por eso toda la audiencia entra por HTTPS por defecto — ver "Hallazgo técnico clave"), y el servidor abre un `SpeechRecognizer` adicional en su idioma usando el mismo `TranslationProvider` de la sesión. Cada frase finalizada se traduce al idioma del presentador (`sourceLanguage` de la sesión, no el `targetLanguage` de la audiencia), se sintetiza en voz (mismo `synthesizer` del proveedor, igual que el pipeline principal) y ambos — texto y audio — se envían **solo al presentador** (`audience_question`, nunca al resto de oyentes) — no pasa por `SessionManager` ni genera `TranscriptSegment`s, es un canal lateral efímero separado del pipeline principal. Si la síntesis de voz falla, `audioUrl` llega como `null` y la pregunta se entrega igual solo como texto, en vez de perderse por completo.

Mientras alguien tiene la palabra, el servidor difunde `question_floor_busy` a todos los oyentes (deshabilita su botón "Preguntar"); al terminar (`end_question` explícito, desconexión del que pregunta, o fin de la sesión) difunde `question_floor_free`. Solo un "piso" (floor) activo a la vez — evita streams de STT simultáneos y audio superpuesto. El presentador responde la pregunta con su propio micrófono de forma normal; esa respuesta sale por el pipeline principal a toda la audiencia, como cualquier otra frase.

`QuestionFloor` solo acepta solicitudes mientras `session.status` es `live` o `paused` - en `discussion` (ver abajo) se usa un mecanismo distinto, `DiscussionFloor`.

### Modo discusión (post-presentación)

Diseñado tras una segunda entrevista de requisitos (misma metodología que la original) — decisiones confirmadas con el usuario antes de implementar.

**Dependencia pendiente de resolver antes de implementar**: este diseño reutiliza `MAX_INTERIM_DURATION_MS`/el corte forzado por tiempo de `TranslationPipeline` - pero esa pieza vive hoy solo en el PR #4 (`claude/simultaneous-chunking-and-tts-speed`), todavía no fusionado a `master` al momento de escribir este spec (esta rama, `claude/discussion-mode`, sale de `master` antes de ese PR). Antes de implementar hay que decidir: fusionar PR #4 primero, o traer esos commits a esta rama (ej. merge/cherry-pick), para no reimplementar el mismo mecanismo dos veces en paralelo.

**Por qué existe**: "Preguntas del público" traduce siempre hacia el presentador y solo él la recibe - sirve para una pregunta puntual durante la charla, pero no para un espacio de discusión abierta donde varias personas (incluido quien dio la charla) van tomando la palabra por turnos y **todos** necesitan escuchar la traducción, no solo quien está en el panel. Dar la palabra manualmente a cada uno desde el panel sería inviable en la práctica.

**Activación**: nuevo estado de sesión `SessionStatus = 'idle' | 'live' | 'paused' | 'discussion'`. El operador del panel (presentador) tiene dos botones nuevos, disponibles **desde cualquier estado** (`start_discussion` funciona incluso desde `idle`, sin haber presentado antes - útil para eventos que son solo una mesa de discusión):
- **"Iniciar discusión"** (`start_discussion`): si había un pipeline de presentación corriendo (`live`/`paused`), se detiene (`pipeline.stop()`) igual que `stop_session`, pero el estado pasa a `discussion` en vez de `idle` - la sesión sigue viva (mismo `Session.id`, oyentes conectados no se reconectan).
- **"Terminar discusión"** (`end_discussion`): libera el `DiscussionFloor` si alguien tenía la palabra, y vuelve a `idle` (simétrico con la activación - no hay ida y vuelta entre `discussion` y `live`; para volver a presentar hay que iniciar sesión de cero).

**Sin presentador fijo durante la discusión**: `sourceLanguage`/`targetLanguage` de la `Session` quedan sin uso (se conservan con su último valor, no se limpian) - el idioma de cada turno lo elige quien habla, no la sesión. El operador del panel pierde su micrófono "siempre activo": en `discussion`, **también** tiene que pedir la palabra para hablar, exactamente igual que cualquier oyente. Esto es lo que resuelve "que sea indiferente quién es el presentador" - durante la discusión, el rol de "quien habla ahora" es dinámico y rota por el mismo mecanismo de turno único para todos, operador incluido.

**`DiscussionFloor`** (`src/ws/discussionFloor.ts`, nuevo - análogo a `QuestionFloor` pero con dos diferencias clave: lo puede pedir CUALQUIERA -oyente o presentador- y el resultado se difunde a TODOS, no solo al presentador):
- Un solo turno activo a la vez (`request_turn {language}` / `end_turn`, mismos nombres de mensaje para presentador y oyente - evita duplicar protocolo). Rechaza si la sesión no está en `discussion`, si ya hay alguien hablando, o si `language` no mapea a español o inglés (`translateCode !== 'es' && translateCode !== 'en'`) - **solo esos dos idiomas están soportados en este modo**, de los 10 de `LANGUAGES`.
- Al conceder el turno, abre un `SpeechRecognizer` en el idioma del que habla (igual que `QuestionFloor`), **con el mismo corte forzado por tiempo máximo que `TranslationPipeline`** (`MAX_INTERIM_DURATION_MS`) - un turno de discusión puede ser tan largo como una intervención en la charla principal, y sin este mecanismo alguien que hable corrido tampoco se traduciría hasta pausar.
- **Enrutamiento por idioma, no broadcast uniforme** (la diferencia arquitectónica más grande de este modo): cada conexión (oyente o presentador) ya tiene asociado su propio "idioma de visualización" (`displayLanguage`, ver abajo). Por cada fragmento (interino, forzado por tiempo, o final):
  - A quienes comparten el idioma de quien habla: se les manda el **texto original**, sin traducir, **sin sintetizar voz** (ya entienden el idioma, no hace falta voz ni gastar en síntesis).
  - A quienes tienen el OTRO idioma (es↔en): se les manda el texto **traducido** + audio sintetizado, igual que el pipeline principal - pero solo una vez que hay texto final/forzado para traducir (los interinos muestran "Traduciendo…" mientras tanto, igual que hoy con "Transcribiendo…").
  - A quienes eligieron un idioma que no es español ni inglés: no reciben nada de la discusión (ni texto ni audio) y no pueden pedir la palabra - ver "Fuera de alcance" abajo.
  - Como máximo hay que traducir+sintetizar **una vez** por fragmento (al idioma contrario al de quien habla, nunca más de uno), no N veces - el enrutamiento es "propio vs. el-otro-de-los-dos", no por cada idioma individual.
- Igual que `QuestionFloor`: se libera (`end_turn`, desconexión del que habla, o fin del modo discusión) deteniendo el `SpeechRecognizer` y notificando a todos (`turn_floor_free`) para que el botón de pedir la palabra se reactive.

**`displayLanguage` por conexión** (nuevo, vive en memoria junto a cada WebSocket, no es una entidad persistida): el oyente ya elige su idioma al unirse (hoy solo se usaba para "Preguntas del público"); ese mismo valor se reutiliza aquí - el cliente lo manda proactivamente (`set_language {language}`) justo al conectar, y el servidor lo guarda asociado a esa conexión (`Map<WebSocket, string>` en `ListenerHub`, y uno equivalente en `PresenterHub` para cuando el operador participa). El operador del panel, al entrar a modo discusión, ve el mismo selector de idioma que un oyente (confirmado explícitamente: trato simétrico) y también manda `set_language`. Reenviar `set_language` más tarde actualiza el valor (idempotente - útil si alguien se equivocó de idioma al unirse).

**UI**: se reutiliza la misma vista de subtítulos de siempre (`#captions` en el oyente, `#transcript` en el presentador) para mostrar la discusión - no hay un panel separado. El botón "Preguntar"/"Pedir la palabra" también se reutiliza: su comportamiento (a quién llega la traducción) depende de `session.status` en el momento de la solicitud (`live`/`paused` → `QuestionFloor`, solo al presentador; `discussion` → `DiscussionFloor`, a todos), pero es la misma interacción física para el usuario.

### Control de acceso del presentador

PIN numérico de 6 dígitos generado al arrancar el servidor (solo visible en la terminal), intercambiado por un token opaco guardado en `sessionStorage`. La vista de oyente no requiere PIN — tampoco para pedir la palabra y preguntar (cualquiera en la LAN puede hacerlo, limitado únicamente por el turno único). Solo la conexión de presentador que inició la sesión activa puede enviar audio del canal principal. El PIN sigue siendo el único control de acceso al panel de administración en sí (`start_discussion`/`end_discussion` lo requieren, igual que el resto de comandos) - "que sea indiferente quién es el presentador" (ver "Modo discusión") es sobre quién habla en cada turno de la discusión, no sobre quién puede abrir el panel.

### Descubribilidad para la audiencia

Al arrancar, el servidor imprime todas las IPs LAN detectadas + genera un QR apuntando a `http://<ip-lan>:<puerto>/`. La URL del presentador por `localhost` se muestra por separado, junto con la(s) URL(s) HTTPS (`https://<ip-lan>:<puerto-https>/presenter`) para cuando el presentador va a usar otro dispositivo (ver "Hallazgo técnico clave" arriba).

## Modelo de datos y CRUD por entidad

Todo en memoria de proceso — nada se persiste a disco.

```ts
type SessionStatus = 'idle' | 'live' | 'paused' | 'discussion';
interface Session {
  id: string; status: SessionStatus;
  sourceLanguage: string; targetLanguage: string; // sin uso durante 'discussion'
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
  - *Create*: `start_session {sourceLanguage, targetLanguage}` por WS (requiere token). Valida contra la tabla de idiomas, rechaza si ya hay sesión `live`/`paused`/`discussion`. `start_discussion` (sin parámetros, requiere token) crea/continúa la sesión en estado `discussion` desde cualquier estado.
  - *Read*: `GET /api/session/status` (REST, público) + push `session_state` a presentador y oyentes.
  - *Update*: `pause_session` / `resume_session` (WS, requiere token) alternan entre `live` y `paused`. Cambiar de idioma sigue sin poder hacerse en caliente: requiere `stop_session` + `start_session`. No hay transición de ida y vuelta entre `discussion` y `live`/`paused` - son modos mutuamente excluyentes dentro de la misma sesión.
  - *Delete*: `stop_session` o `end_discussion` (WS, requiere token) — limpia todo el estado en memoria, notifica `session_ended`.
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
  - *Read*: cada frase finalizada se traduce y se sintetiza en voz, y ambas (`audioUrl` puede ser `null` si la síntesis falla) se envían **solo al presentador** (`audience_question`); el resto de la audiencia solo ve `question_floor_busy`/`question_floor_free` (sin contenido de la pregunta).
  - *Update*: no aplica — no hay edición de una pregunta en curso, solo existe/no existe.
  - *Delete*: `end_question` del propio asker, su desconexión, o el fin de la sesión — todos liberan el floor (`question_floor_free`) y detienen el `SpeechRecognizer`.
- **Discussion floor** (singleton efímero, un turno a la vez - solo existe mientras `session.status === 'discussion'`, no es una entidad persistida ni parte de `Session`):
  - *Create*: `request_turn {language}` por WS de **cualquier** conexión autenticada o no (oyente o presentador) — rechaza si `session.status !== 'discussion'`, si `language` no mapea a español/inglés, o si ya hay alguien con la palabra (`turn_denied`); si no, concede (`turn_granted`) y abre un `SpeechRecognizer` en el idioma de quien habla.
  - *Read*: cada fragmento (interino, forzado por `MAX_INTERIM_DURATION_MS`, o final) se enruta por `displayLanguage` de cada conexión - texto original sin audio para quienes comparten idioma con quien habla; texto traducido + audio para quienes tienen el otro de los dos (es↔en); nada para quienes eligieron otro idioma de los 10 soportados en el resto de la app.
  - *Update*: no aplica — igual que Question floor, un turno existe o no existe, no se edita.
  - *Delete*: `end_turn` de quien habla, su desconexión, o `end_discussion`/fin de la sesión — liberan el floor (`turn_floor_free`) y detienen el `SpeechRecognizer`.
- **`displayLanguage` por conexión** (vive en memoria junto a cada WebSocket - oyente o presentador -, no es una entidad persistida ni parte de `Session`):
  - *Create*: `set_language {language}` por WS, enviado proactivamente al conectar (oyente) o al entrar a modo discusión (presentador).
  - *Read*: usado internamente por el Discussion floor para decidir qué variante (propia o traducida) mandarle a cada conexión; no se expone vía ningún GET.
  - *Update*: reenviar `set_language` sobrescribe el valor (idempotente).
  - *Delete*: implícito al cerrarse la conexión.

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
      index.ts                # factory createProvider('google'|'local', 'google'|'elevenlabs')
      google/
        speechStream.ts       # SttStreamManager
        translate.ts
        tts.ts
      elevenlabs/
        tts.ts                # SpeechSynthesizer alterno, seleccionable con TTS_PROVIDER=elevenlabs
    ws/
      presenterSocket.ts
      listenerSocket.ts
      questionFloor.ts          # turno unico de "pedir la palabra" para preguntas del publico
      discussionFloor.ts        # turno unico post-presentacion, difunde a TODOS (no solo al presentador)
    routes.ts
    network.ts
    tls.ts                    # genera el certificado autofirmado para el servidor HTTPS
  public/
    presenter/  {index.html, presenter.css, presenter.js}
    listen/     {index.html, listen.css, listen.js}
    shared/pcm-worklet.js
```

## Fuera de alcance (v1)

Cuentas de usuario · persistencia/historial de transcripciones · multi-sesión simultánea · selección de idioma **de recepción** por oyente individual durante la charla principal (el idioma que cada oyente elige al unirse sigue siendo solo para si pregunta/participa, no cambia en qué idioma recibe la interpretación principal mientras `session.status` es `live`/`paused`, que sigue siendo uno solo por sesión - **durante `discussion` sí hay enrutamiento por idioma de cada oyente, pero limitado a español/inglés**, ver "Modo discusión") · integración real con Teams (solo se deja la puerta arquitectónica abierta) · proveedor local/gratuito implementado (solo la interfaz) · app móvil nativa · acceso remoto fuera de la LAN (el HTTPS que sí existe es solo para el contexto seguro del micrófono dentro de la red local, no para exponer la app a internet) · certificado HTTPS confiable/de una autoridad reconocida (es autofirmado a propósito) · cambio de idioma en caliente · varias preguntas/turnos simultáneos (un piso, un hablante a la vez, tanto en "Preguntas del público" como en "Modo discusión") · que la pregunta traducida llegue a la audiencia durante `live`/`paused` (solo al presentador - en `discussion` sí llega a todos, es el propósito del modo nuevo) · modo discusión en idiomas distintos a español/inglés · cola visible de quién va después a pedir la palabra (ni en Preguntas del público ni en Modo discusión - es estrictamente "el primero que toca el botón, lo tiene") · ida y vuelta entre `discussion` y `live`/`paused` dentro de la misma sesión (son modos mutuamente excluyentes; volver a presentar requiere una sesión nueva).

## Riesgos y limitaciones conocidas

- Palabra pronunciada justo en el instante de un reinicio de stream STT: mitigado con el ring buffer de replay, no eliminado al 100%.
- Un presentador que hable muy corrido podría generar un segmento cerca del límite de 5.000 bytes por request de TTS — partición defensiva en oraciones si el texto traducido supera ~4.500 bytes.
- Si el WiFi del lugar pierde salida a internet, todo el pipeline se detiene (se usa Google Cloud, no un proveedor local).
- Aislamiento de clientes en redes WiFi de invitados impediría que los oyentes alcancen el servidor — riesgo de infraestructura del lugar.
- Un AP doméstico soporta confiablemente ~30-50 clientes; escalar a "un par de cientos" de oyentes requiere un AP de nivel empresarial.
- iOS Safari puede pausar el audio si el oyente bloquea la pantalla.
- Nada detiene automáticamente una sesión olvidada salvo la desconexión del presentador.
- Modo discusión: si un oyente eligió un idioma fuera de español/inglés al unirse, no puede participar ni ver/escuchar nada de la discusión (ni un mensaje explicándolo más allá de que el botón de pedir la palabra no funciona) - limitación aceptada explícitamente, no un descuido.
- Modo discusión: si el ASR revisa palabras ya entregadas en un fragmento anterior (mismo trade-off que el corte forzado por tiempo de la charla principal), esa corrección se pierde - no se re-traduce ni se re-envía.
- No hay forma de "saltarse" o forzar la liberación del turno desde el panel si quien lo tiene se queda colgado sin cerrar su pestaña (solo la desconexión real libera el floor) - un moderador no puede quitarle la palabra a alguien a mitad de turno.
- La voz de las preguntas del público (`#question-player` en el panel del presentador) depende del mismo desbloqueo de autoplay que el audio principal de los oyentes — se intenta "primar" con un play()/pause() síncrono en el submit del login, pero un navegador más estricto podría bloquearla igual; el texto de la pregunta siempre llega de todas formas, con o sin audio.

**Lección de CSS (ya corregida)**: `listen.css` tenía `#join-screen { display: flex; ... }` con un selector de ID, que por especificidad le gana a la regla por defecto del navegador `[hidden] { display: none }` (selector de atributo). Resultado: `el('join-screen').hidden = true` en JS no ocultaba nada - la pantalla de "Unirme" se quedaba visible, apilada encima de la de oyente, dando la impresión de que el botón "no reaccionaba" al unirse. Arreglado con una regla defensiva `[hidden] { display: none !important; }` al inicio de la hoja de estilos, que gana sin importar qué otra regla por ID/clase exista. Lección para cualquier CSS nuevo en este proyecto: nunca poner una propiedad `display` en un selector de ID/clase que compita con el atributo `hidden` de ese mismo elemento.

## Tests automatizados

`npm test` corre la suite (node:test + tsx, sin dependencias extra) sobre todo lo que no requiere credenciales reales ni un navegador: ciclo de vida de `SessionManager` (incluyendo pausar/reanudar), `TranslationPipeline` con un proveedor falso, los wrappers de Google (`translate.ts`/`tts.ts`/`speechStream.ts`, incluyendo el reinicio del stream tras un error) y de ElevenLabs (`elevenlabs/tts.ts`, con `fetch` inyectado) con un cliente/fetch falso, la generación del certificado autofirmado (`tls.ts`), el turno único de preguntas (`questionFloor.ts`: conceder/denegar, traducción, liberación), las rutas REST contra un servidor real en un puerto efímero, y el cableado completo de WebSockets (`app.ts`) incluyendo el ciclo start/pausar/reanudar/detener y el flujo completo de preguntas del público (conceder/denegar/liberar, también al terminar la sesión) de punta a punta **sobre HTTP y sobre HTTPS**. Fuera de alcance de esta suite: el frontend/AudioWorklet (no testeable sin navegador) y el pipeline de audio real contra APIs reales (requiere credenciales y micrófono reales) - ambos cubiertos por la verificación manual de abajo.

**Nota de diseño de tests**: los tests de WebSocket que esperan un mensaje de *broadcast* disparado por la acción de OTRO socket deben registrar ese `waitForMessage` **antes** de disparar la acción (guardar la promesa, disparar, luego esperarla) — si el broadcast no tiene ninguna espera asíncrona de por medio en el servidor, puede llegar y perderse antes de que el test esté escuchando, colgando el test indefinidamente en vez de fallar con un timeout. Ver el comentario sobre `waitForMessage` en `app.test.ts`.

**Pendiente al implementar el modo discusión**: `discussionFloor.test.ts` (unitario, mismo patrón que `questionFloor.test.ts`: fake provider, fake WebSockets, verificar conceder/denegar/traducir/enrutar-por-idioma/liberar) y una extensión de `app.test.ts` (integración, mismo patrón que las pruebas de "audience questions") cubriendo: `start_discussion`/`end_discussion` desde cada estado, que el presentador también tenga que pedir la palabra, que el enrutamiento por idioma entregue la variante correcta a cada conexión (propia vs. traducida), y que el corte forzado por tiempo máximo también aplique dentro de un turno de discusión largo.

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
11. **Preguntas del público**: tras hacer login como presentador (confirma que después de unirse, la pantalla de "Unirme" del oyente desaparece de verdad y no queda apilada encima - ver la lección de CSS arriba), en la vista de oyente elegir un idioma distinto al de la charla, tocar "Preguntar", conceder el permiso de micrófono, hablar una pregunta corta. Confirmar que: (a) el botón "Preguntar" se deshabilita en los demás oyentes mientras tanto, (b) la pregunta traducida aparece en el panel del presentador y se **escucha** en voz (no solo texto) y NO en la vista de los demás oyentes, (c) tocar "Terminar pregunta" libera el turno y reactiva el botón para todos, (d) un segundo oyente que intenta preguntar mientras el primero tiene la palabra recibe un mensaje de "otra persona está preguntando".
12. **Modo discusión**: con al menos 2 oyentes conectados (uno con idioma español, otro con inglés), desde el panel tocar "Iniciar discusión" (probar desde `idle` directamente, sin haber presentado antes). Confirmar: (a) el panel del presentador también muestra el selector de idioma + botón de pedir la palabra, sin micrófono activo por defecto; (b) un oyente en español pide la palabra y habla - el oyente en inglés ve el texto traducido y escucha el audio, mientras un tercer oyente TAMBIÉN en español solo ve el texto original sin audio; (c) mientras alguien tiene la palabra, nadie más (ni el operador) puede pedirla; (d) al terminar el turno, el operador pide la palabra y responde - le llega traducido a los oyentes en inglés igual que a cualquier otro; (e) un oyente con un idioma fuera de español/inglés no puede pedir la palabra ni ve nada de la discusión; (f) alguien habla sin pausar más de `MAX_INTERIM_DURATION_MS` - confirmar que igual se traduce por fragmentos en vez de esperar a que pause; (g) "Terminar discusión" vuelve todo a `idle` y notifica a los oyentes.
