// Insertion-ordered cache: refreshes replace old entries and evict the oldest.
// A byte budget also bounds caches containing variable-sized MQTT messages.
class BoundedMap extends Map {
  constructor({ maxEntries = 1000, maxWeight = Infinity, weigh = () => 1 } = {}) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !(maxWeight > 0)) {
      throw new RangeError('Invalid cache limits');
    }
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weigh = weigh;
    this.weights = new Map();
    this.weight = 0;
  }

  set(key, value) {
    const weight = this.weigh(value, key);
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Invalid cache weight');
    this.delete(key);
    if (weight > this.maxWeight) return this;
    super.set(key, value);
    this.weights.set(key, weight);
    this.weight += weight;
    while (this.size > this.maxEntries || this.weight > this.maxWeight) {
      this.delete(this.keys().next().value);
    }
    return this;
  }

  delete(key) {
    this.weight -= this.weights.get(key) || 0;
    this.weights.delete(key);
    return super.delete(key);
  }

  clear() {
    super.clear();
    this.weights.clear();
    this.weight = 0;
  }
}

module.exports = { BoundedMap };
