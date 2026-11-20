const policies = new Set(['no-referrer','no-referrer-when-downgrade','same-origin','origin','strict-origin','origin-when-cross-origin','strict-origin-when-cross-origin','unsafe-url']);
export const default_referrer_policy = 'strict-origin-when-cross-origin';

export function parse_referrer_policy(value, fallback = default_referrer_policy) {
  let policy = fallback;
  for (const token of String(value || '').split(',')) if (policies.has(token.trim().toLowerCase())) policy = token.trim().toLowerCase();
  return policy;
}

export function request_referrer(input, destination, policy = default_referrer_policy) {
  if (!input) return '';
  let source;
  try { source = new URL(input); } catch { return ''; }
  if (!['http:','https:'].includes(source.protocol)) return '';
  source.username = source.password = source.hash = '';
  const target = new URL(destination), same = source.origin === target.origin;
  const origin = source.origin + '/';
  const full = source.href.length > 4096 ? origin : source.href;
  const downgrade = source.protocol === 'https:' && target.protocol !== 'https:';
  // Chromium treats Blob navigation as a non-cryptographic destination even
  // when its embedded origin matches. Preserve that scheme during comparison.
  if(target.protocol==='blob:'&&downgrade&&!['same-origin','origin','unsafe-url'].includes(policy))return '';
  switch (policy) {
    case 'no-referrer': return '';
    case 'same-origin': return same ? full : '';
    case 'origin': return origin;
    case 'strict-origin': return downgrade ? '' : origin;
    case 'origin-when-cross-origin': return same ? full : origin;
    case 'unsafe-url': return full;
    case 'no-referrer-when-downgrade': return downgrade ? '' : full;
    default: return same ? full : downgrade ? '' : origin;
  }
}

export function request_origin(source, destination, {method = 'GET', mode = 'no-cors', policy = default_referrer_policy, tainted = false, cors = false} = {}) {
  const origin = new URL(source).origin, target = new URL(destination);
  if (!cors && !['websocket','webtransport'].includes(mode) && /^(GET|HEAD)$/i.test(method)) return null;
  if (tainted) return 'null';
  // Script fetches retain Origin even when their Referer is suppressed (as in
  // Chromium's fetch implementation). Navigation policies can anonymize it.
  if (mode === 'navigate') {
    if (policy === 'no-referrer' || policy === 'same-origin' && origin !== target.origin) return 'null';
    if (['no-referrer-when-downgrade','strict-origin','strict-origin-when-cross-origin'].includes(policy) && new URL(source).protocol === 'https:' && target.protocol !== 'https:') return 'null';
  }
  return origin;
}
