function findLocalProjectUrl(output) {
  const plain = String(output || '').replace(/\u001b\[[0-9;]*m/g, '');
  const candidates = plain.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?/gi) || [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),;]+$/, ''));
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) continue;
      if (url.port && (+url.port < 1 || +url.port > 65535)) continue;
      return url.href;
    } catch {}
  }
  return null;
}

module.exports = { findLocalProjectUrl };
