function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDuckDuckGoUrl(href) {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    const target = redirected ? new URL(redirected) : parsed;
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return '';
    return target.href;
  } catch { return ''; }
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const anchors = html.matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const anchor of anchors) {
    const url = unwrapDuckDuckGoUrl(anchor[1].replace(/&amp;/g, '&'));
    const title = decodeHtml(anchor[2]);
    if (!url || !title) continue;
    const afterAnchor = html.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 2500);
    const snippetMatch = afterAnchor.match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    results.push({ title: title.slice(0, 300), url, snippet: snippetMatch ? decodeHtml(snippetMatch[1]).slice(0, 700) : '' });
    if (results.length >= 5) break;
  }
  return results;
}

async function searchWeb(query, fetchImpl = globalThis.fetch) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery || cleanQuery.length > 200 || /[\r\n\0]/.test(cleanQuery)) throw new Error('La consulta de cerca no és vàlida.');
  if (typeof fetchImpl !== 'function') throw new Error('Aquest runtime no té disponible la connexió web.');
  const response = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 AgenticCoder/1.0 (web search)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`El cercador ha respost amb HTTP ${response.status}.`);
  const html = (await response.text()).slice(0, 2_000_000);
  const results = parseDuckDuckGoResults(html);
  if (!results.length) return { query: cleanQuery, results: [], message: 'No s’han trobat resultats o el cercador ha canviat el format de la pàgina.' };
  return { query: cleanQuery, results };
}

/** The readable text of an HTML page: no scripts, styles, navigation or markup. */
function pageText(html) {
  const body = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/section)\s*\/?>/gi, '\n');
  return body.split('\n').map((line) => decodeHtml(line)).filter(Boolean).join('\n');
}

/** Only public web pages: nothing on this machine or on the local network. */
function publicWebUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('L’adreça no és vàlida.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Només es poden llegir adreces http o https.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') || /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.includes(':')) {
    throw new Error('Aquesta eina només llegeix pàgines públiques d’Internet. Per a una pàgina local, fes servir el navegador de l’app.');
  }
  url.username = ''; url.password = '';
  return url;
}

/** Reads one public page and returns its text, so the agent can follow a search result or read documentation. */
async function readWebPage(address, fetchImpl = globalThis.fetch) {
  const url = publicWebUrl(address);
  if (typeof fetchImpl !== 'function') throw new Error('Aquest runtime no té disponible la connexió web.');
  const response = await fetchImpl(url.href, {
    headers: { 'user-agent': 'Mozilla/5.0 AgenticCoder/1.0 (page reader)', accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1' },
    signal: AbortSignal.timeout(15000), redirect: 'follow',
  });
  if (!response.ok) throw new Error(`La pàgina ha respost amb HTTP ${response.status}.`);
  const type = String(response.headers?.get?.('content-type') || '');
  if (type && !/text\/|json|xml/i.test(type)) throw new Error(`La pàgina no és text (${type.split(';')[0]}).`);
  const raw = (await response.text()).slice(0, 2_000_000);
  const title = /html/i.test(type) || /<html|<body/i.test(raw) ? decodeHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || '') : '';
  const text = /html/i.test(type) || /<html|<body/i.test(raw) ? pageText(raw) : raw;
  return { url: url.href, title: title.slice(0, 300), text: text.slice(0, 9000), truncated: text.length > 9000 };
}

module.exports = { parseDuckDuckGoResults, searchWeb, pageText, publicWebUrl, readWebPage };
