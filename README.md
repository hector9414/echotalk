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

## Correr la app

```bash
npm run dev
```

La terminal va a imprimir:

- Un **PIN** de 6 dígitos (solo se muestra aquí, no lo compartas con la audiencia).
- La URL del **panel del presentador** por `localhost` (`http://localhost:<puerto>/presenter`) — úsala si ESTA máquina tiene micrófono.
- La URL **HTTPS** del panel del presentador (`https://<ip-lan>:<puerto-https>/presenter`) — úsala si vas a presentar desde **otro dispositivo** (ver abajo).
- La(s) URL(s) de **oyentes** en la red LAN, más un código QR.

## Cómo usarla

1. Abre el panel del presentador con la URL que corresponda (ver "Usar el celular como presentador" si esta máquina no tiene micrófono). Ingresa el PIN.
2. Elige el idioma de origen (el que va a hablar el orador) y el idioma de destino (el que va a recibir la audiencia), y presiona "Iniciar".
3. La audiencia escanea el QR (o entra a la URL LAN mostrada) desde su navegador y toca "Unirme".
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

Sin cuentas de usuario, sin historial guardado, un solo idioma de destino por sesión, sin integración real con Microsoft Teams todavía. Ver la sección "Fuera de alcance" y "Riesgos y limitaciones conocidas" en [SPEC.md](./SPEC.md) para el detalle completo.
