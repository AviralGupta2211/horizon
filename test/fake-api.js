/* A stand-in for the Claude Messages API, for tests. It is a local HTTPS server that Chrome is told to use in
   place of api.anthropic.com, so the page's real request code, the browser's real cross-origin checks and the
   page's real content policy are all exercised. Nothing here talks to Anthropic.

   It follows what the real API was documented and seen to do on 17 Nov 2026 (API version 2026-10-21):
   the preflight answer, the headers a browser call needs, the shape of replies (thinking blocks, then text
   blocks) and the shape and wording of errors. Needs openssl, to make a throwaway certificate. */
const https = require('https'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const HZ = require('../js/core.js'), makeModel = require('./fake-model.js');

const TEST_KEY = 'sk-ant-api03-TEST-ONLY-this-is-not-a-real-key-0000000000-wxyz'; // a made-up value for tests
const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const WORKSPACE = 'wrkspc_test01';

function throwawayCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=api.anthropic.com'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function start() {
  const api = {
    key: TEST_KEY, calls: [], preflights: 0, model: makeModel(HZ),
    mode: 'ok',            // ok | rate | overloaded | server | billing | refusal | cut | fenced | org_blocked
    delay: 30, needWorkspace: false, noEffort: false
  };
  const srv = https.createServer(throwawayCert(), (req, rsp) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'vary': 'Origin, Access-Control-Request-Headers' };
    if (req.method === 'OPTIONS') { // as the real API answers: any origin, and the headers the browser asked for
      api.preflights++;
      rsp.writeHead(200, Object.assign({ 'access-control-allow-methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '', 'access-control-max-age': '600' }, cors));
      rsp.end('ok'); return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch (e) {}
      api.calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj) => setTimeout(() => { if (rsp.destroyed) return; rsp.writeHead(status, Object.assign({ 'content-type': 'application/json', 'request-id': 'req_test' }, cors)); rsp.end(JSON.stringify(obj)); }, api.delay);
      const fail = (status, type, message) => send(status, { type: 'error', error: { type, message }, request_id: 'req_test' });
      const reply = (content, stop) => send(200, { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_details: null, usage: { input_tokens: 100, output_tokens: 100 } });
      const h = req.headers;

      if (req.method !== 'POST' || req.url !== '/v1/messages') return fail(404, 'not_found_error', 'Not found');
      const key = /^Bearer /.test(h.authorization || '') ? h.authorization.slice(7) : h['x-api-key'];
      if (!key) return fail(401, 'authentication_error', 'x-api-key header is required');
      if (key !== api.key) return fail(401, 'authentication_error', 'invalid x-api-key');
      // a call from a web page carries an Origin header and must opt in (the real wording of this refusal is not documented)
      if (h.origin && h['anthropic-dangerous-direct-browser-access'] !== 'true') return fail(401, 'authentication_error', 'Browser requests must include the anthropic-dangerous-direct-browser-access header');
      if (api.mode === 'org_blocked') return fail(401, 'authentication_error', 'CORS requests are not allowed for this Organization because of custom retention settings');
      if (!h['anthropic-version']) return fail(400, 'invalid_request_error', 'anthropic-version: header is required');
      if (!body || typeof body.model !== 'string' || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || !Array.isArray(body.messages) || !body.messages.length) return fail(400, 'invalid_request_error', 'The request body is not a valid Messages request');
      for (const gone of ['temperature', 'top_p', 'top_k']) if (gone in body) return fail(400, 'invalid_request_error', gone + ': not supported in this API version'); // removed in 2026-10-21
      if (body.thinking && ['enabled', 'disabled', 'between_tools'].includes(body.thinking.type)) return fail(400, 'invalid_request_error', 'thinking.type: not supported by every model, so the app must not send it');
      if (api.needWorkspace && !h['anthropic-workspace-id']) return fail(400, 'invalid_request_error', 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.');
      if (h['anthropic-workspace-id'] && h['anthropic-workspace-id'] !== WORKSPACE) return fail(404, 'not_found_error', 'Workspace `' + h['anthropic-workspace-id'] + '` not found.');
      if (!MODELS.includes(body.model)) return fail(404, 'not_found_error', 'model: ' + body.model);
      if (api.noEffort && body.output_config) return fail(400, 'invalid_request_error', 'output_config.effort: this model does not support the effort parameter');
      if (api.mode === 'rate') return fail(429, 'rate_limit_error', 'This request would exceed your rate limit.');
      if (api.mode === 'overloaded') return fail(529, 'overloaded_error', 'Overloaded');
      if (api.mode === 'server') return fail(500, 'api_error', 'Internal server error');
      if (api.mode === 'billing') return fail(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');

      const prompt = body.messages.map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join(''))).join('\n');
      const think = { type: 'thinking', thinking: '', signature: 'sig_test' }; // thinking is on by default and its text is left out
      if (/single word: ok/.test(prompt)) return reply([think, { type: 'text', text: 'ok' }], 'end_turn');
      if (api.mode === 'refusal') return reply([], 'refusal');
      let text = JSON.stringify(api.model.answer(prompt));
      if (api.mode === 'cut') return reply([think, { type: 'text', text: text.slice(0, 60) }], 'max_tokens');
      if (api.mode === 'fenced') text = 'Here is the JSON:\n```json\n' + text + '\n```';
      const half = Math.floor(text.length / 2); // a reply may come as more than one text block
      reply([think, { type: 'text', text: text.slice(0, half) }, { type: 'text', text: text.slice(half) }], 'end_turn');
    });
  });
  return new Promise((res, rej) => {
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res({ api, port: srv.address().port, close: () => srv.close() }));
  });
}
module.exports = { start, TEST_KEY, WORKSPACE, MODELS };
