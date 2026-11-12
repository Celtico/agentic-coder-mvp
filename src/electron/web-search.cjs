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

module.exports = { parseDuckDuckGoResults, searchWeb };
