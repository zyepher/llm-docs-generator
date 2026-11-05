/**
 * inspectWebsite against a loopback HTTP server: the bounded resource plan
 * (explicit URL, llms.txt, sitemap.xml), candidate evidence, freshness
 * metadata, truncation, and input validation that never echoes credentials.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectWebsite } from '../../src/core/website-discovery.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        })
    )
  );
});

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    handler(request, response);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  servers.push(server);

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port');
  }
  const { port }: AddressInfo = address;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function writeHttpResponse(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { 'content-type': contentType, ...headers });
  response.end(body);
}

describe('inspectWebsite', () => {
  it('inspects the explicit URL plus same-origin llms.txt and sitemap.xml, and nothing else', async () => {
    const { baseUrl, requests } = await startTestServer((request, response) => {
      const origin = `http://${request.headers.host ?? ''}`;
      const pathname = new URL(request.url ?? '/', origin).pathname;

      switch (pathname) {
        case '/docs/page':
          writeHttpResponse(
            response,
            200,
            'text/html; charset=utf-8',
            [
              '<!doctype html><html>',
              '<head><link rel="canonical" href="/docs/page?view=canonical#section"></head>',
              '<body>',
              '<a href="/docs/api#intro">API</a>',
              '<a href="https://github.com/example/repo">GitHub</a>',
              '<a href="/openapi.json">Spec</a>',
              '<a href="/pricing">Pricing</a>',
              '<a href="/blog">Blog</a>',
              '</body></html>',
            ].join(''),
            { etag: '"docs-page-v1"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }
          );
          return;
        case '/llms.txt':
          writeHttpResponse(
            response,
            200,
            'text/plain',
            [
              '# Links',
              '',
              '[Guide](/docs/llms-guide.md)',
              'https://external.example/openapi.json',
            ].join('\n'),
            { etag: 'W/"llms-v1"' }
          );
          return;
        case '/sitemap.xml':
          writeHttpResponse(
            response,
            200,
            'application/xml',
            [
              '<?xml version="1.0" encoding="UTF-8"?><urlset>',
              `<url><loc>${origin}/docs/sitemap-entry</loc></url>`,
              `<url><loc>${origin}/docs/api</loc></url>`,
              '</urlset>',
            ].join(''),
            { 'last-modified': 'Thu, 22 Oct 2015 07:28:00 GMT' }
          );
          return;
        default:
          writeHttpResponse(response, 500, 'text/plain', `Unexpected request: ${pathname}`);
      }
    });

    const explicitUrl = `${baseUrl}/docs/page`;
    const inspection = await inspectWebsite({ url: explicitUrl, allowPrivateHosts: true });

    expect(requests.map((path) => new URL(path, baseUrl).pathname)).toEqual([
      '/docs/page',
      '/llms.txt',
      '/sitemap.xml',
    ]);
    expect(inspection).toMatchObject({
      website: { input: explicitUrl, normalizedUrl: explicitUrl, origin: baseUrl },
      crawlPolicy: {
        inspectedResourceUrls: [explicitUrl, `${baseUrl}/llms.txt`, `${baseUrl}/sitemap.xml`],
        sameOriginWellKnownResources: [`${baseUrl}/llms.txt`, `${baseUrl}/sitemap.xml`],
        linkedCandidateFetches: false,
        renderedJavaScript: false,
        timeoutMs: 10000,
        maxBytesPerResponse: 65536,
        maxCandidates: 200,
        candidateLimitReached: false,
      },
      warnings: [],
    });
    expect(inspection.inspectedResources).toEqual([
      {
        url: explicitUrl,
        status: 200,
        contentType: 'text/html',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'explicit-url',
        freshness: {
          observedAt: expect.any(String),
          etag: '"docs-page-v1"',
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        },
      },
      {
        url: `${baseUrl}/llms.txt`,
        status: 200,
        contentType: 'text/plain',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'llms-txt',
        freshness: { observedAt: expect.any(String), etag: 'W/"llms-v1"', lastModified: null },
      },
      {
        url: `${baseUrl}/sitemap.xml`,
        status: 200,
        contentType: 'application/xml',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'sitemap-xml',
        freshness: {
          observedAt: expect.any(String),
          etag: null,
          lastModified: 'Thu, 22 Oct 2015 07:28:00 GMT',
        },
      },
    ]);
    for (const resource of inspection.inspectedResources) {
      expect(new Date(resource.freshness.observedAt).toISOString()).toBe(
        resource.freshness.observedAt
      );
    }

    const candidateUrls = inspection.candidates.map((candidate) => candidate.url);
    expect(candidateUrls).toEqual([
      `${baseUrl}/docs/page?view=canonical`,
      `${baseUrl}/docs/api`,
      'https://github.com/example/repo',
      `${baseUrl}/openapi.json`,
      `${baseUrl}/docs/llms-guide.md`,
      'https://external.example/openapi.json',
      `${baseUrl}/docs/sitemap-entry`,
    ]);
    expect(inspection.candidates.map((candidate) => candidate.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);

    const apiCandidate = inspection.candidates.find(
      (candidate) => candidate.url === `${baseUrl}/docs/api`
    );
    expect(apiCandidate).toMatchObject({
      sameOrigin: true,
      external: false,
      evidence: { relations: ['link', 'sitemap-loc'], flags: ['docs-like-url'] },
    });
    expect(apiCandidate?.sourceResources).toEqual([
      { url: explicitUrl, sourceRole: 'explicit-url', evidence: 'link' },
      { url: `${baseUrl}/sitemap.xml`, sourceRole: 'sitemap-xml', evidence: 'sitemap-loc' },
    ]);

    const githubCandidate = inspection.candidates.find(
      (candidate) => candidate.url === 'https://github.com/example/repo'
    );
    expect(githubCandidate).toMatchObject({ sameOrigin: false, external: true });
    expect(githubCandidate?.evidence.flags).toEqual(['github-url']);

    const specCandidate = inspection.candidates.find(
      (candidate) => candidate.url === `${baseUrl}/openapi.json`
    );
    expect(specCandidate?.evidence.flags).toEqual(['machine-readable-url']);
    expect(specCandidate?.evidence.signals).toContain('path:machine-readable-like');

    // The evidence is for the planner to judge; it makes no authority claims.
    const evidenceText = JSON.stringify(inspection);
    expect(evidenceText).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(evidenceText).not.toMatch(/\bofficial\b/i);
    expect(evidenceText).not.toMatch(/\bscore\b/i);
    expect(evidenceText).not.toMatch(/\bselected\b/i);
  });

  it('truncates an oversized response at the byte cap and records a warning', async () => {
    const { baseUrl } = await startTestServer((request, response) => {
      if (request.url === '/docs/page') {
        writeHttpResponse(
          response,
          200,
          'text/html',
          `<html><body><a href="/docs/first">First</a>${'x'.repeat(70_000)}<a href="/docs/late">Late</a></body></html>`
        );
        return;
      }
      writeHttpResponse(response, 404, 'text/plain', 'not found');
    });

    const inspection = await inspectWebsite({
      url: `${baseUrl}/docs/page`,
      allowPrivateHosts: true,
    });
    const warning = `Response truncated at 65536 bytes for explicit-url resource: ${baseUrl}/docs/page`;

    expect(inspection.inspectedResources[0]).toMatchObject({
      url: `${baseUrl}/docs/page`,
      status: 200,
      byteSize: 65536,
      truncated: true,
      sourceRole: 'explicit-url',
    });
    expect(inspection.warnings).toContain(warning);
    const candidateUrls = inspection.candidates.map((candidate) => candidate.url);
    expect(candidateUrls).toContain(`${baseUrl}/docs/first`);
    expect(candidateUrls).not.toContain(`${baseUrl}/docs/late`);
  });

  it('rejects unusable URLs before fetching and never echoes credentials', async () => {
    await expect(inspectWebsite({ url: 'ftp://example.com/docs' })).rejects.toThrow(
      'Unsupported URL scheme for discover --url: ftp:'
    );
    await expect(inspectWebsite({ url: 'not-a-url' })).rejects.toThrow(
      'Malformed URL for discover --url.'
    );

    const malformedCredentials = inspectWebsite({ url: 'https://user:secret@' });
    await expect(malformedCredentials).rejects.toThrow('Malformed URL for discover --url.');
    await expect(malformedCredentials).rejects.not.toThrow(/secret/);

    await expect(inspectWebsite({ url: 'https://user:secret@example.com/docs' })).rejects.toThrow(
      'Embedded credentials are not supported in discover --url.'
    );
    await expect(inspectWebsite({ url: 'http://169.254.169.254/latest' })).rejects.toThrow(
      /only https:\/\/ URLs are fetched/
    );
    await expect(inspectWebsite({ url: 'https://169.254.169.254/latest' })).rejects.toThrow(
      /169\.254\.169\.254 is a link-local address/
    );
    await expect(inspectWebsite({ url: 'https://[::ffff:10.0.0.1]/' })).rejects.toThrow(
      /is a private address/
    );
  });

  it('refuses a hostname that resolves to a private address and records it as a warning', async () => {
    const { baseUrl, requests } = await startTestServer((_request, response) => {
      writeHttpResponse(response, 200, 'text/html', '<html></html>');
    });
    const port = new URL(baseUrl).port;
    const inspection = await inspectWebsite({
      url: `https://docs.example.test:${port}/`,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    expect(requests).toEqual([]);
    expect(inspection.inspectedResources.every((resource) => resource.status === null)).toBe(true);
    expect(inspection.warnings[0]).toMatch(/127\.0\.0\.1 is a loopback address/);
  });

  it('serves plain http to loopback only with the private-network switch', async () => {
    const { baseUrl } = await startTestServer((_request, response) => {
      writeHttpResponse(response, 200, 'text/html', '<html></html>');
    });

    await expect(inspectWebsite({ url: `${baseUrl}/` })).rejects.toThrow(
      /plain http is allowed only to loopback/
    );
    const inspection = await inspectWebsite({ url: `${baseUrl}/`, allowPrivateHosts: true });
    expect(inspection.inspectedResources[0]?.status).toBe(200);
  });
});
