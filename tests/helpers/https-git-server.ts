import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';

/**
 * HTTPS servers for git-over-HTTPS tests: a self-signed certificate generated
 * on the spot for `localhost` and `127.0.0.1`, trusted by this process (the
 * HTTP client) and by git (`GIT_SSL_CAINFO`), and `git http-backend` serving
 * real repositories behind a Node HTTPS server.
 */

export interface TestCertificate {
  certPath: string;
  cert: string;
  key: string;
}

export async function createTestCertificate(dir: string): Promise<TestCertificate> {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return {
    certPath,
    cert: await readFile(certPath, 'utf-8'),
    key: await readFile(keyPath, 'utf-8'),
  };
}

/** Trust the certificate in this process; returns the undo. git trusts it via GIT_SSL_CAINFO. */
export function trustCertificate(certificate: TestCertificate): () => void {
  const previous = getCACertificates('default');
  setDefaultCACertificates([...previous, certificate.cert]);
  return () => setDefaultCACertificates(previous);
}

export interface TestHttpsServer {
  origin: string;
  /** Every request's method and path with query, in arrival order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startHttpsServer(
  certificate: TestCertificate,
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<TestHttpsServer> {
  const requests: string[] = [];
  const server: Server = createServer(
    { cert: certificate.cert, key: certificate.key },
    (request, response) => {
      requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
      handler(request, response);
    }
  );
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

/**
 * A handler running `git http-backend` (smart HTTP, protocol v2, filters
 * allowed) over the repositories under `projectRoot`, which also holds the
 * backend's empty global config file.
 */
export async function gitHttpBackend(
  projectRoot: string
): Promise<(request: IncomingMessage, response: ServerResponse) => void> {
  const emptyConfig = join(projectRoot, '.backend-gitconfig');
  await writeFile(emptyConfig, '');

  return (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'https://backend.invalid');
      const header = (name: string): string => {
        const value = request.headers[name];
        return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
      };
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'uploadpack.allowFilter',
          GIT_CONFIG_VALUE_0: 'true',
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          GIT_PROTOCOL: header('git-protocol'),
          REQUEST_METHOD: request.method ?? 'GET',
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: header('content-type'),
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: header('content-encoding'),
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      // git http-backend answers some requests without reading the body.
      child.stdin.on('error', () => undefined);
      child.stdin.end(body);
      child.on('close', () => {
        const raw = Buffer.concat(output);
        const split = raw.indexOf('\r\n\r\n');
        const headerEnd = split === -1 ? raw.indexOf('\n\n') : split;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of raw.subarray(0, headerEnd).toString('latin1').split(/\r?\n/)) {
          const colon = line.indexOf(':');
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') {
            status = Number.parseInt(value, 10);
          } else if (name !== '') {
            headers[name] = value;
          }
        }
        response.writeHead(status, headers);
        response.end(raw.subarray(headerEnd + (split === -1 ? 2 : 4)));
      });
    });
  };
}
