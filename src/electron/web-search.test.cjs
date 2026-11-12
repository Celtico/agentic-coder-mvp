const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDuckDuckGoResults, searchWeb } = require('./web-search.cjs');

test('parses public search results and unwraps DuckDuckGo redirects', () => {
  const target = encodeURIComponent('https://example.org/docs?a=1&b=2');
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${target}&amp;rut=abc">Example &amp; Docs</a><a class="result__snippet">Useful &lt;reference&gt;</a></div>`;
  assert.deepEqual(parseDuckDuckGoResults(html), [{
    title: 'Example & Docs', url: 'https://example.org/docs?a=1&b=2', snippet: 'Useful <reference>',
  }]);
});

test('searches with a short encoded query and returns readable result links', async () => {
  let requestedUrl = '';
  const fetchStub = async (url, options) => {
    requestedUrl = url;
    assert.equal(options.signal instanceof AbortSignal, true);
    return { ok: true, status: 200, text: async () => '<a class="result__a" href="https://example.org/">Example</a><span class="result__snippet">A result.</span>' };
  };
  const result = await searchWeb('Chakra UI tree view', fetchStub);
  assert.match(requestedUrl, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
  assert.match(requestedUrl, /Chakra%20UI%20tree%20view/);
  assert.equal(result.results[0].url, 'https://example.org/');
  assert.equal(result.results[0].title, 'Example');
});

test('rejects empty or oversized web search queries', async () => {
  await assert.rejects(searchWeb('   ', async () => { throw new Error('must not fetch'); }), /consulta de cerca no és vàlida/);
  await assert.rejects(searchWeb('x'.repeat(201), async () => { throw new Error('must not fetch'); }), /consulta de cerca no és vàlida/);
});
