function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function configuredNumber(value, fallback, minimum = 0) {
  const number = finiteNumber(value);
  return Math.max(minimum, number === null ? fallback : number);
}

function isValidTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 8640000000000000;
}

module.exports = { finiteNumber, configuredNumber, isValidTimestamp };
