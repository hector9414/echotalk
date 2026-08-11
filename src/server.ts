import { PORT, PROVIDER_NAME } from './config';
import { createProvider } from './providers';
import { buildApp } from './app';
import type { NetworkInfo } from './routes';
import {
  buildListenerUrl,
  buildPresenterUrl,
  generateQrDataUrl,
  generateQrTerminal,
  getLanIpAddresses,
} from './network';

async function main(): Promise<void> {
  const provider = createProvider(PROVIDER_NAME);

  const lanIps = getLanIpAddresses();
  const listenerUrls = lanIps.map((ip) => buildListenerUrl(ip, PORT));
  const networkInfo: NetworkInfo = {
    listenerUrls,
    qrDataUrl: listenerUrls.length > 0 ? await generateQrDataUrl(listenerUrls[0]) : null,
  };

  const { server, auth } = buildApp(provider, networkInfo);

  server.listen(PORT, '0.0.0.0', async () => {
    const presenterUrl = buildPresenterUrl(PORT);

    console.log('');
    console.log('=== EchoTalk ===');
    console.log(`PIN del presentador (no lo compartas con la audiencia): ${auth.pin}`);
    console.log(`Panel del presentador (abrir SIEMPRE por localhost): ${presenterUrl}`);
    if (listenerUrls.length === 0) {
      console.log('No se detecto ninguna IP de red local. Conecta esta maquina a WiFi/Ethernet.');
    } else {
      console.log('URL(es) para la audiencia (misma red WiFi):');
      for (const url of listenerUrls) console.log(`  ${url}`);
      try {
        console.log(await generateQrTerminal(listenerUrls[0]));
      } catch {
        // Terminal QR rendering is best-effort only; the printed URL above is enough on its own.
      }
    }
    console.log('================');
    console.log('');
  });
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
