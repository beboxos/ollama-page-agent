const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function loadWorker(fetch) {
  let messageListener;
  const chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: {
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    permissions: { contains: async () => true },
    tabs: { captureVisibleTab: async () => '', sendMessage() {} },
    webNavigation: { getAllFrames(_options, callback) { callback([]); } },
  };
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), { chrome, fetch, URL, console });
  return (message) => new Promise((resolve) => messageListener(message, { tab: { id: 1 }, frameId: 0 }, resolve));
}

test('converts a vision image to the OpenAI image_url shape', async () => {
  let payload;
  const call = loadWorker(async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  });
  const response = await call({
    type: 'CHAT', provider: 'openai', baseUrl: 'http://127.0.0.1:52625', model: 'vision',
    messages: [{ role: 'user', content: 'analyse', images: ['YWJj'] }],
  });
  assert.equal(response.ok, true);
  assert.equal(response.imageCount, 1);
  assert.equal(payload.messages[0].content[1].type, 'image_url');
  assert.equal(payload.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,YWJj');
});

test('retries OpenAI-compatible servers without response_format', async () => {
  const payloads = [];
  const call = loadWorker(async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    if (payloads.length === 1) return { ok: false, status: 422, text: async () => 'unsupported response_format' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  });
  const response = await call({
    type: 'CHAT', provider: 'openai', baseUrl: 'http://127.0.0.1:52625', model: 'text',
    messages: [{ role: 'user', content: 'bonjour' }],
  });
  assert.equal(response.ok, true);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].response_format, { type: 'json_object' });
  assert.equal('response_format' in payloads[1], false);
});
