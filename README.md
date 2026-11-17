# EchoTalk

[![CI/CD](https://github.com/hector9414/echotalk/actions/workflows/ci.yml/badge.svg)](https://github.com/hector9414/echotalk/actions/workflows/ci.yml)

App web de interpretación simultánea para audiencias: un orador habla, y la audiencia recibe la traducción en vivo (subtítulos + voz) en el navegador de su propio teléfono, conectándose por WiFi local — sin instalar nada.

Ver [SPEC.md](./SPEC.md) para el diseño técnico completo, el modelo de datos y las limitaciones conocidas.

## Requisitos

- Node.js 20 o superior.
- Por defecto (`PROVIDER=google`): una cuenta de Google Cloud con las APIs **Speech-to-Text**, **Cloud Translation** y **Text-to-Speech** habilitadas, y facturación activa. Alternativa sin nube y sin costo de API, con menor calidad: `PROVIDER=local` — ver "Proveedor local" abajo.
- La laptop que va a correr el servidor y la audiencia deben estar en la misma red WiFi. Con `PROVIDER=google` esa red también debe tener salida a internet (las tres APIs son en la nube); con `PROVIDER=local` no, salvo para instalar los modelos la primera vez.

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

## Proveedor local (sin nube, gratis, pero con menor calidad)

`PROVIDER=local` reemplaza las 3 piezas (reconocimiento de voz, traducción y voz) por un stack que corre en tu propia máquina, sin costo de API — a cambio de subtítulos que aparecen por bloques de ~2 segundos (no palabra por palabra como con Google) y de menor calidad de traducción/voz. Ver "Proveedor local" en [SPEC.md](./SPEC.md) para el detalle completo de esa limitación antes de usarlo en un evento real.

Ninguna de las tres piezas la instala esta app automáticamente al correr `npm install` — pero sí hay un script que automatiza la descarga/compilación/instalación de las tres (fuera de git, nunca se suben al repo):

```bash
scripts/setup-local-provider.sh
```

Esto clona y compila whisper.cpp + descarga un modelo (STT), instala LibreTranslate en un venv de Python propio (traducción), e instala Piper + descarga voces para es-ES/en-US/en-GB/fr-FR/de-DE/it-IT/pt-BR (voz) — todo queda en `./local-provider/` (ignorado por git). Al final imprime los 3 comandos exactos para arrancar cada proceso y las variables para tu `.env`. Puedes omitir piezas con `--skip-stt`/`--skip-translate`/`--skip-tts`, o ajustar qué se descarga con las variables `WHISPER_MODEL`, `LT_LANGUAGES` y `PIPER_VOICES` (ver los comentarios al inicio del script). Nota: `es-US`/`ja-JP`/`zh-CN` no tienen una voz de Piper por defecto (no hay certeza de un nombre oficial) — si las necesitas, búscalas en [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) y agrégalas a `PIPER_VOICES`.

Si prefieres instalar cada pieza a mano: [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (compilar + `models/download-ggml-model.sh`, correr `build/bin/whisper-server -m <modelo> --port 8178`), [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) (`pip install libretranslate && libretranslate --port 5000`), y [Piper](https://github.com/OHF-Voice/piper1-gpl) (`pip install piper-tts` + un archivo `<languageId>.onnx` + `<languageId>.onnx.json` por idioma, nombrados así, en una carpeta).

Luego, en tu `.env` (el script de arriba ya te imprime esto con las rutas exactas):
```bash
PROVIDER=local
LOCAL_STT_URL=http://127.0.0.1:8178
LOCAL_TRANSLATE_URL=http://127.0.0.1:5000
PIPER_BINARY_PATH=/ruta/a/local-provider/piper-venv/bin/piper
PIPER_MODEL_DIR=/ruta/a/local-provider/piper-voices
```
`TTS_PROVIDER` no necesitas tocarlo: con `PROVIDER=local` ya asume `piper` por defecto (en vez de `google`), para no llamar a la nube sin querer.

Con los 3 procesos corriendo, reinicia el servidor (`npm run dev` o `npm start`).

Puedes ajustar `LOCAL_STT_CHUNK_INTERVAL_MS`, `LOCAL_STT_SILENCE_MS` y `LOCAL_STT_SILENCE_RMS_THRESHOLD` en `.env` si el subtítulo tarda demasiado en aparecer o el final de frase se corta a mitad de palabra — depende del micrófono y del ruido ambiente.

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

Por eso ahora **toda la audiencia** entra por HTTPS desde el inicio (antes solo era necesario para presentar desde otro dispositivo): cualquiera podría necesitar su micrófono para preguntar, así que todos aceptan la advertencia de certificado al unirse.

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

Sin cuentas de usuario, sin historial guardado, un solo idioma de destino por sesión, sin integración nativa con Microsoft Teams (solo enrutamiento manual de audio, ver arriba). El proveedor local (`PROVIDER=local`) no da subtítulos palabra por palabra como Google, sino por bloques de ~2 segundos. Ver la sección "Fuera de alcance" y "Riesgos y limitaciones conocidas" en [SPEC.md](./SPEC.md) para el detalle completo.
