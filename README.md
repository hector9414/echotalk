# EchoTalk

[![CI/CD](https://github.com/hector9414/echotalk/actions/workflows/ci.yml/badge.svg)](https://github.com/hector9414/echotalk/actions/workflows/ci.yml)

App web de interpretación simultánea para audiencias: un orador habla, y la audiencia recibe la traducción en vivo (subtítulos + voz) en el navegador de su propio teléfono, conectándose por WiFi local — sin instalar nada.

Ver [SPEC.md](./SPEC.md) para el diseño técnico completo, el modelo de datos y las limitaciones conocidas.

## Requisitos

- Node.js 20 o superior.
- Una cuenta de Google Cloud con las APIs **Speech-to-Text**, **Cloud Translation** y **Text-to-Speech** habilitadas, y facturación activa.
- La laptop que va a correr el servidor y la audiencia deben estar en la misma red WiFi, y esa red debe tener salida a internet (las tres APIs son en la nube).

## Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` según cómo vayas a autenticarte con Google Cloud (ver abajo).

## Autenticación con Google Cloud

Dos opciones:

1. **Recomendado para desarrollo local**: instala el [SDK de gcloud](https://cloud.google.com/sdk/docs/install) y corre:
   ```bash
   gcloud auth application-default login
   ```
   Deja `GOOGLE_APPLICATION_CREDENTIALS` vacío en `.env`.

2. **Cuenta de servicio**: crea una cuenta de servicio en la consola de Google Cloud con los roles de Speech-to-Text, Cloud Translation y Text-to-Speech, descarga el JSON de credenciales, guárdalo como `gcp-service-account.json` en la raíz del proyecto (ya está en `.gitignore`, nunca lo subas al repo) y apunta `GOOGLE_APPLICATION_CREDENTIALS` a esa ruta.

## Usar ElevenLabs para la voz (opcional)

Por defecto, la voz que escucha la audiencia también sale de Google Cloud (Text-to-Speech). Si quieres probar la voz de **ElevenLabs** en su lugar (mejor calidad, más costosa — ver comparación de costos en [SPEC.md](./SPEC.md)), el reconocimiento de voz y la traducción **siguen siendo de Google**; solo se cambia la narración:

1. Crea una cuenta en [elevenlabs.io](https://elevenlabs.io) y copia tu API key desde la pestaña **Profile** (o Settings → API Keys).
2. Elige una voz en la pestaña **Voices** del dashboard y copia su `voice_id` (o consíguelo vía `GET /v1/voices`).
3. En tu `.env`, configura:
   ```bash
   TTS_PROVIDER=elevenlabs
   ELEVENLABS_API_KEY=tu_api_key_aqui
   ELEVENLABS_VOICE_ID=el_voice_id_que_copiaste
   ELEVENLABS_MODEL_ID=eleven_multilingual_v2   # o el modelo que prefieras
   ```
4. Reinicia el servidor (`npm run dev` o `npm start`). La terminal va a mostrar `Motor de voz (TTS): elevenlabs` en el banner de arranque, confirmando que está activo.

Si `TTS_PROVIDER=elevenlabs` y falta `ELEVENLABS_API_KEY` o `ELEVENLABS_VOICE_ID`, el servidor falla al iniciar con un mensaje claro indicando cuál variable falta — no arranca a medias.

Para volver a Google, pon `TTS_PROVIDER=google` (o bórralo, es el valor por defecto) y reinicia.

## Que la traducción no se quede atrás del orador

Dos ajustes en `.env` para que la interpretación se sienta más "en vivo":

- **`MAX_INTERIM_DURATION_MS`** (default `5000`): si hablas sin pausas por más de este tiempo, la app traduce y narra lo que lleves acumulado hasta ahora de todas formas, en vez de esperar a que detecte una pausa natural. Sin esto, alguien que habla muy corrido puede estar 20+ segundos sin que se traduzca nada. Bajarlo (ej. `3000`) da subtítulos más seguidos, a costa de cortar las frases en fragmentos más chicos.
- **`TTS_SPEAKING_RATE`** (default `1.15`, o sea 15% más rápido que la voz normal): entre más rápido hable la voz traducida, menos se acumula el audio pendiente en la cola del oyente. Rango válido en Google: `0.25` a `4.0` — `1.2`-`1.3` sigue sonando claro; pasado `1.5` empieza a sonar robótico. Si usas ElevenLabs, el rango soportado es más angosto (`0.7`-`1.2` aprox.).

Para una voz de Google con cadencia naturalmente más ágil (no solo por `speakingRate`), puedes fijar una voz específica por idioma en `src/config.ts` (campo `ttsVoiceName` de `LANGUAGES`, ej. `es-ES-Neural2-B` o `en-US-Neural2-C` — las voces Neural2/Chirp3 suenan más claras que las Standard a velocidades altas). Confirma nombres de voz vigentes en la consola de Google Cloud Text-to-Speech, ya que el catálogo cambia.

## Correr la app

```bash
npm run dev
```

La terminal va a imprimir:

- Un **PIN** de 6 dígitos (solo se muestra aquí, no lo compartas con la audiencia).
- La URL del **panel del presentador** por `localhost` (`http://localhost:<puerto>/presenter`) — úsala si ESTA máquina tiene micrófono.
- La URL **HTTPS** del panel del presentador (`https://<ip-lan>:<puerto-https>/presenter`) — úsala si vas a presentar desde **otro dispositivo** (ver abajo).
- La(s) URL(s) de **oyentes** en la red LAN (HTTPS por defecto — ver "Preguntas del público"), más un código QR.

## Cómo usarla

1. Abre el panel del presentador con la URL que corresponda (ver "Usar el celular como presentador" si esta máquina no tiene micrófono). Ingresa el PIN.
2. Elige el idioma de origen (el que va a hablar el orador) y el idioma de destino (el que va a recibir la audiencia), y presiona "Iniciar".
3. La audiencia escanea el QR (o entra a la URL mostrada) desde su navegador, acepta la advertencia de certificado (una vez), elige su propio idioma (por si quiere preguntar) y toca "Unirme".
4. Puedes **pausar** la interpretación (ej. para un receso o preguntas) sin perder la sesión ni desconectar a los oyentes, y **reanudar** cuando sigas. "Detener" sí termina la sesión por completo.

## Usar el celular (u otro dispositivo) como presentador

Si la máquina que corre el servidor **no tiene micrófono** (ej. un PC de escritorio), el presentador puede usar su celular en su lugar — el micrófono real siempre es el del dispositivo donde se abre el panel, nunca el de la máquina que corre el servidor.

El navegador exige un "contexto seguro" (HTTPS, o `localhost`) para dar acceso al micrófono; una IP de LAN por HTTP plano no sirve. Por eso el servidor también levanta un puerto HTTPS (activado por defecto, ver `ENABLE_HTTPS`/`HTTPS_PORT` en `.env.example`) con un certificado autofirmado generado automáticamente en cada arranque — no requiere ninguna configuración de tu parte.

Pasos:
1. Conecta tu celular a la **misma red WiFi** que la máquina del servidor.
2. En el celular, abre la URL `https://...` que aparece en la terminal (no la URL `http://` de los oyentes).
3. El navegador va a mostrar una advertencia de **"conexión no privada"** — es esperado, el certificado es autofirmado (no lo emite una autoridad reconocida, pero sigue siendo una conexión cifrada). Toca "Avanzado" → "Continuar de todas formas" (el texto exacto varía según el navegador).
4. Ingresa el PIN y continúa normalmente — el micrófono del celular es el que va a capturar al orador.

Si prefieres desactivar esto (por ejemplo, porque siempre vas a presentar desde la misma laptop que corre el servidor), pon `ENABLE_HTTPS=false` en `.env`.

## Preguntas del público

La audiencia también puede preguntar, con su propia voz, usando su idioma nativo:

1. Al "Unirme", cada oyente elige su idioma en una lista — es el idioma en el que va a hablar si pregunta (no tiene que coincidir con el idioma de destino de la interpretación).
2. Cualquier oyente puede tocar **"Preguntar"**. Si nadie más está preguntando, el navegador le pide permiso de micrófono y empieza a grabar.
3. Mientras alguien tiene la palabra, el botón "Preguntar" se deshabilita para el resto de la audiencia (solo una persona puede preguntar a la vez).
4. Al tocar **"Terminar"** (o automáticamente, si la sesión se detiene), el texto final de la pregunta se traduce al idioma del presentador y se muestra **únicamente en el panel del presentador** — el resto de la audiencia no la ve ni la escucha.

Mientras alguien tiene la palabra, el presentador ve un banner avisando "Alguien del público está preguntando" — es solo informativo, la app no pausa su micrófono por su cuenta; si quiere, el presentador pausa manualmente con el botón de siempre.

Por eso ahora **toda la audiencia** entra por HTTPS desde el inicio (antes solo era necesario para presentar desde otro dispositivo): cualquiera podría necesitar su micrófono para preguntar, así que todos aceptan la advertencia de certificado al unirse.

## Seguir escuchando al cambiar de app o minimizar el celular

Los navegadores móviles suspenden una pestaña en segundo plano salvo que reconozcan que está reproduciendo audio activamente. Para que la interpretación no se corte al minimizar Chrome o cambiar de app:

- La vista de oyente registra la sesión como "reproduciendo ahora" ante el sistema (Media Session API) — deberías ver un control de reproducción en la pantalla de bloqueo/notificaciones con el nombre "EchoTalk", igual que con Spotify o YouTube Music. Esto es lo que mantiene el audio sonando en segundo plano en Android Chrome. El soporte en iOS Safari es más limitado.
- Si la conexión sí se cae (la pestaña se suspendió del todo, o hay un corte de red), la app reconecta sola — con reintentos automáticos, y de inmediato al volver a la pestaña/app — en vez de quedarse con un mensaje de "recarga la página". No hay historial que recuperar: al reconectar vuelves a recibir subtítulos/audio nuevos desde ese momento, no lo que te perdiste mientras estuvo desconectado.

No existe una ventana flotante de Picture-in-Picture como la de video — los navegadores no ofrecen esa API para audio — pero lo anterior cubre la necesidad real (que el audio no se corte al salir de la app).

## Integración con Microsoft Teams (manual)

No hay una integración nativa con Teams todavía (ver "Fuera de alcance" en [SPEC.md](./SPEC.md)). La forma de usarlo hoy es enrutando el audio a nivel de sistema operativo:

1. Instala [VB-CABLE](https://vb-audio.com/Cable/) (u otro cable de audio virtual) en la máquina que corre el servidor.
2. En el navegador donde está abierto el panel de **oyente** (el que recibe la voz traducida), selecciona el dispositivo de salida de audio "CABLE Input" en vez de tus parlantes.
3. En Teams, en Configuración → Dispositivos, selecciona "CABLE Output" como micrófono.
4. Así, lo que EchoTalk reproduce como voz traducida entra a Teams como si fuera tu micrófono. Para escuchar tú mismo mientras tanto, herramientas como [Voicemeeter](https://vb-audio.com/Voicemeeter/) permiten mezclar "CABLE Output" con tus parlantes reales.

Es una solución manual de enrutamiento de audio del sistema operativo, no una integración de EchoTalk con la API de Teams.

## Build de producción

```bash
npm run build
npm start
```

## Tests

```bash
npm test
```

Corre la suite (`node:test`, sin dependencias extra) sobre toda la lógica que no requiere credenciales reales de Google Cloud ni un navegador. Se ejecuta automáticamente en cada PR vía GitHub Actions — ver [.github/workflows/ci.yml](./.github/workflows/ci.yml). Detalle de qué cubre en la sección "Tests automatizados" de [SPEC.md](./SPEC.md).

## Limitaciones conocidas

Sin cuentas de usuario, sin historial guardado, un solo idioma de destino por sesión, sin integración nativa con Microsoft Teams (solo enrutamiento manual de audio, ver arriba), sin ventana flotante de Picture-in-Picture (los navegadores no la ofrecen para audio - ver "Seguir escuchando..." arriba). Ver la sección "Fuera de alcance" y "Riesgos y limitaciones conocidas" en [SPEC.md](./SPEC.md) para el detalle completo.
