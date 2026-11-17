import selfsigned from 'selfsigned';

export interface HttpsCredentials {
  cert: string;
  key: string;
}

// X.509 GeneralName type codes used in the subjectAltName extension below:
// 2 = dNSName, 7 = iPAddress.
const DNS_NAME_TYPE = 2;
const IP_ADDRESS_TYPE = 7;

// Generates a fresh self-signed certificate every time the server starts
// (nothing is written to disk - the private key only ever lives in memory
// for this process). It's valid for localhost/127.0.0.1 plus every LAN IP
// detected at startup, so a phone connecting to this run's actual address
// gets a certificate that matches the host it's talking to - the browser
// still shows a "connection not private" warning (expected: it's not signed
// by a recognized authority), but accepting it once is enough. This exists
// specifically so a phone can be used as the presenter when the machine
// running the server has no microphone: getUserMedia requires a secure
// context, and a LAN IP over plain HTTP never qualifies, only HTTPS or
// localhost do - see SPEC.md "Hallazgo tecnico clave: contexto seguro".
export function generateSelfSignedCert(lanIps: string[]): HttpsCredentials {
  const altNames = [
    { type: DNS_NAME_TYPE, value: 'localhost' },
    { type: IP_ADDRESS_TYPE, ip: '127.0.0.1' },
    ...lanIps.map((ip) => ({ type: IP_ADDRESS_TYPE, ip })),
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: 'echotalk.local' }], {
    days: 1,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  return { cert: pems.cert, key: pems.private };
}
