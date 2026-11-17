import { ENABLE_HTTPS, HTTPS_PORT, PORT, PROVIDER_NAME, TTS_PROVIDER_NAME } from './config';
import { createProvider } from './providers';
import { buildApp } from './app';
import type { NetworkInfo } from './routes';
import {
  buildListenerHttpsUrl,
  buildListenerUrl,
  buildPresenterHttpsUrl,
  buildPresenterUrl,
  generateQrDataUrl,
  generateQrTerminal,
  getLanIpAddresses,
} from './network';

function listen(server: { listen: (port: number, host: string, cb: () => void) => unknown }, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
}

async function main(): Promise<void> {
  const provider = createProvider(PROVIDER_NAME, TTS_PROVIDER_NAME);

  const lanIps = getLanIpAddresses();
  // Audience URLs default to HTTPS when it's enabled (the normal case) so
  // anyone can ask a question with their own mic without switching URLs
  // mid-event - see SPEC.md "Preguntas del público". Falls back to plain
  // HTTP only if ENABLE_HTTPS=false, in which case nobody but the presenter
  // (via localhost) gets microphone access at all.
  const listenerUrls = lanIps.map((ip) =>
    ENABLE_HTTPS ? buildListenerHttpsUrl(ip, HTTPS_PORT) : buildListenerUrl(ip, PORT),
  );
  const networkInfo: NetworkInfo = {
    listenerUrls,
    qrDataUrl: listenerUrls.length > 0 ? await generateQrDataUrl(listenerUrls[0]) : null,
  };

  const { server, httpsServer, auth } = buildApp(provider, networkInfo, lanIps);

  await listen(server, PORT);
  if (httpsServer) {
    await listen(httpsServer, HTTPS_PORT);
  }

  const presenterUrl = buildPresenterUrl(PORT);

  console.log('');
  console.log('=== EchoTalk ===');
  console.log(`PIN del presentador (no lo compartas con la audiencia): ${auth.pin}`);
  console.log(`Motor de voz (TTS): ${TTS_PROVIDER_NAME}`);
  console.log(`Panel del presentador (si ESTA maquina tiene microfono): ${presenterUrl}`);

  if (httpsServer && lanIps.length > 0) {
    console.log('Panel del presentador DESDE OTRO DISPOSITIVO (ej. tu celular, si esta');
    console.log('maquina no tiene microfono) - acepta la advertencia de certificado una vez:');
    for (const ip of lanIps) console.log(`  ${buildPresenterHttpsUrl(ip, HTTPS_PORT)}`);
  } else if (!httpsServer) {
    console.log('HTTPS desactivado (ENABLE_HTTPS=false) - el presentador solo puede usar esta maquina, por');
    console.log('localhost, y el publico no podra hacer preguntas con microfono.');
  }

  if (listenerUrls.length === 0) {
    console.log('No se detecto ninguna IP de red local. Conecta esta maquina a WiFi/Ethernet.');
  } else {
    console.log(
      ENABLE_HTTPS
        ? 'URL(es) para la audiencia (misma red WiFi) - acepta la advertencia de certificado una vez:'
        : 'URL(es) para la audiencia (misma red WiFi):',
    );
    for (const url of listenerUrls) console.log(`  ${url}`);
    try {
      console.log(await generateQrTerminal(listenerUrls[0]));
    } catch {
      // Terminal QR rendering is best-effort only; the printed URL above is enough on its own.
    }
  }
  console.log('================');
  console.log('');
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
