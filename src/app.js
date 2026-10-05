'use strict';

const http = require('http');
const { ApiError } = require('./errors');
const { reconstructStripeService } = require('./service');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the 8 MiB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (req.method === 'POST' && path === '/api/stripes/reconstruct') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new ApiError(400, 'INVALID_JSON', 'request body is not valid JSON');
        }
        sendJson(res, 200, reconstructStripeService(body));
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown route' } });
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      } else {
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
      }
    }
  });
}

module.exports = { createApp };
