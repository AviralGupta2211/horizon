/* Checks for the parts of js/env.js that can be checked without a browser: reading the API's replies and errors.
   The error texts are the ones the real API returned, or its documentation quoted, on 17 Nov 2026.
   Run: node test/env.test.js */
const assert = require('assert');
const E = require('../js/env.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}
const err = (type, message) => ({ type: 'error', error: { type, message }, request_id: 'req_011Ch86C4SrMzoFZdef2Pbnv' });

test('the page may contact one other server, and load nothing from anywhere else', () => {
  const hosts = E.POLICY.match(/https?:\/\/[^\s;]+/g);
  assert.deepStrictEqual(hosts, ['https://api.anthropic.com']);
  assert.ok(E.POLICY.includes("default-src 'none'") && E.POLICY.includes("script-src 'self'") && E.POLICY.includes("base-uri 'none'") && E.POLICY.includes("form-action 'none'"));
  assert.ok(!/script-src[^;]*unsafe/.test(E.POLICY) && !E.POLICY.includes('*'), 'no inline or evaluated script, no wildcards');
  assert.strictEqual(E.API_URL, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(E.API_VERSION, '2026-10-21');
});

test('a reply is read from its text blocks, in order, skipping the thinking', () => {
  const data = { content: [{ type: 'thinking', thinking: '', signature: 'EosnCkYICxIM' }, { type: 'redacted_thinking', data: 'xx' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], stop_reason: 'end_turn' };
  assert.strictEqual(E.textOf(data), '{"a":1}');
  assert.strictEqual(E.textOf({ content: [] }), ''); assert.strictEqual(E.textOf(null), ''); assert.strictEqual(E.textOf({ content: 'nope' }), '');
});

test('JSON is found whether it comes bare, fenced, or with a sentence around it', () => {
  assert.deepStrictEqual(E.parseJson('{"units":[],"move":{"kind":"door"}}'), { units: [], move: { kind: 'door' } });
  assert.deepStrictEqual(E.parseJson('  \n{"a":1}\n '), { a: 1 });
  assert.deepStrictEqual(E.parseJson('```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
  assert.deepStrictEqual(E.parseJson('Here you go:\n```\n{"a":2}\n```\nHope that helps.'), { a: 2 });
  assert.deepStrictEqual(E.parseJson('Sure. {"a":3} That is all.'), { a: 3 });
  ['', '   ', 'ok', '42', '"text"', 'null', '{"a":', 'no braces here', undefined, null].forEach((t) => assert.strictEqual(E.parseJson(t), undefined, 'not usable: ' + t));
});

test('errors from the API become the app\'s own codes', () => {
  const code = (status, type, message) => E.mapError(status, err(type, message)).code;
  assert.strictEqual(code(401, 'authentication_error', 'invalid x-api-key'), 'bad_key');
  assert.strictEqual(code(401, 'authentication_error', 'x-api-key header is required'), 'bad_key');
  assert.strictEqual(code(401, 'authentication_error', 'CORS requests are not allowed for this Organization because of custom retention settings'), 'org_blocked');
  assert.strictEqual(code(401, 'authentication_error', 'CORS requests are not allowed for this Organization because of its settings'), 'org_blocked');
  assert.strictEqual(code(402, 'billing_error', 'Payment required'), 'billing');
  assert.strictEqual(code(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'billing');
  assert.strictEqual(code(403, 'permission_error', 'Your API key does not have permission to use the specified resource.'), 'no_permission');
  assert.strictEqual(code(400, 'invalid_request_error', 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use...'), 'need_workspace');
  assert.strictEqual(code(400, 'invalid_request_error', 'anthropic-workspace-id header must be a valid workspace ID.'), 'bad_workspace');
  assert.strictEqual(code(404, 'not_found_error', 'Workspace `wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ` not found.'), 'bad_workspace');
  assert.strictEqual(code(404, 'not_found_error', 'model: claude-nope-9'), 'bad_model');
  assert.strictEqual(code(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.'), 'prompt_too_large');
  assert.strictEqual(code(429, 'rate_limit_error', 'This request would exceed your rate limit.'), 'rate_limited');
  assert.strictEqual(code(529, 'overloaded_error', 'Overloaded'), 'overloaded');
  assert.strictEqual(code(500, 'api_error', 'Internal server error'), 'upstream_error');
  assert.strictEqual(code(504, 'timeout_error', 'Timed out'), 'upstream_error');
  assert.strictEqual(code(400, 'invalid_request_error', 'messages: Field required'), 'bad_request');
  // a reply that is not the API's JSON at all (a proxy's error page, say)
  assert.deepStrictEqual(E.mapError(502, null), { code: 'upstream_error', status: 502, detail: '' });
  assert.deepStrictEqual(E.mapError(401, { error: 'nope' }), { code: 'bad_key', status: 401, detail: '' });
  const long = E.mapError(400, err('invalid_request_error', 'x'.repeat(1000)));
  assert.ok(long.detail.length <= 240, 'the API\'s sentence is clipped before it is shown');
});

test('only a well-formed key and settings are ever kept', () => {
  const key = 'sk-ant-api03-TEST-ONLY-this-is-not-a-real-key-0000000000-wxyz';
  assert.deepStrictEqual(E.cleanConn({ key }), { key, workspace: '', main: E.MODELS.main, quick: E.MODELS.quick });
  assert.deepStrictEqual(E.cleanConn({ key, workspace: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ', main: 'claude-opus-5-5', quick: 'claude-haiku-5-5' }), { key, workspace: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ', main: 'claude-opus-5-5', quick: 'claude-haiku-5-5' });
  assert.deepStrictEqual(E.cleanConn({ key, workspace: 'has spaces', main: '<script>', quick: 7 }), { key, workspace: '', main: E.MODELS.main, quick: E.MODELS.quick });
  [null, {}, { key: '' }, { key: 'short' }, { key: 'has a space in the middle of it 000000' }, { key: 'smart“quote”' + 'x'.repeat(30) }, { key: 'x'.repeat(500) }, { key: 42 }].forEach((bad) => assert.strictEqual(E.cleanConn(bad), null));
  assert.deepStrictEqual(E.MODELS, { main: 'claude-sonnet-5-5', quick: 'claude-haiku-5-5' });
});

test('long text is cut into pieces a browser voice can finish', () => {
  const text = 'Name it. The world in your head has a name. ' + 'This sentence is here to make the passage long enough to need cutting into several pieces. '.repeat(6) + 'A door for next time. ' + 'word '.repeat(120);
  const parts = E.speechChunks(text);
  assert.ok(parts.length >= 4);
  parts.forEach((p) => assert.ok(p.length > 0 && p.length <= 220, 'piece of ' + p.length));
  assert.strictEqual(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' ').trim(), 'nothing lost, nothing repeated');
  assert.deepStrictEqual(E.speechChunks(''), []); assert.deepStrictEqual(E.speechChunks('Short.'), ['Short.']);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : ''));
