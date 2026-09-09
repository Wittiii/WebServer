const { createHash, timingSafeEqual } = require('node:crypto');

function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  // Browsers normalize backslashes to slashes in URLs. Controls could likewise
  // turn into a protocol-relative URL when a browser strips tabs/newlines.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

function credentialsMatch(username, password, expectedUsername, expectedPassword) {
  if (![username, password, expectedUsername, expectedPassword].every(
    (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096
  )) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  const userMatches = timingSafeEqual(digest(username), digest(expectedUsername));
  const passwordMatches = timingSafeEqual(digest(password), digest(expectedPassword));
  return userMatches && passwordMatches;
}

function createLoginAttemptLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000, maxEntries = 2048, now = Date.now } = {}) {
  const attempts = new Map();
  function current(key) {
    const entry = attempts.get(key);
    if (entry && entry.expiresAt <= now()) {
      attempts.delete(key);
      return undefined;
    }
    return entry;
  }
  return {
    retryAfter(key) {
      const entry = current(key);
      return entry && entry.count >= maxAttempts ? Math.max(1, Math.ceil((entry.expiresAt - now()) / 1000)) : 0;
    },
    recordFailure(key) {
      let entry = current(key);
      if (!entry) {
        if (attempts.size >= maxEntries) {
          for (const [candidate, value] of attempts) {
            if (value.expiresAt <= now()) attempts.delete(candidate);
          }
          if (attempts.size >= maxEntries) attempts.delete(attempts.keys().next().value);
        }
        entry = { count: 0, expiresAt: now() + windowMs };
        attempts.set(key, entry);
      }
      entry.count += 1;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

module.exports = { safeReturnPath, credentialsMatch, createLoginAttemptLimiter };
