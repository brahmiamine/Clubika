import { createServer } from 'node:http';
import next from 'next';
import { loadSecretFilesFromEnv } from './app/lib/ops/load-secret-files';
import { attachChatSocketServer } from './app/lib/chat/socket-server';
import { assertEncryptionConfiguredForProduction } from './app/lib/crypto/secret-box';

loadSecretFilesFromEnv();

// Refuse un démarrage en production sans APP_ENCRYPTION_KEY plutôt que de dégrader
// silencieusement le chiffrement des messages de chat et des mots de passe SMTP (issue #212).
try {
  assertEncryptionConfiguredForProduction();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const dev = process.env.NODE_ENV !== 'production';
const listenHost = process.env.HOSTNAME || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '3000', 10);
// Next.js utilise `hostname` pour se fetcher lui-même (images). `0.0.0.0` n'est
// pas une origine joignable — d'où `Can't load image https://0.0.0.0:3000/...`.
const nextHostname = listenHost === '0.0.0.0' || listenHost === '::'
  ? '127.0.0.1'
  : listenHost;
const app = next({ dev, hostname: nextHostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((request, response) => handle(request, response));
const { io, stopSessionRevocationListener } = attachChatSocketServer(httpServer);

httpServer.listen(port, listenHost, () => {
  console.log(`Clubika listening on http://${listenHost}:${port}`);
});

function shutdown() {
  stopSessionRevocationListener();
  io.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
