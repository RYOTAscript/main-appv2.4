// A Map that evicts its least-recently-used entry once it grows past
// maxSize. Used for the process-lifetime lyrics/audio-analysis caches, which
// would otherwise grow without bound in this always-on tray app as the user
// listens to more tracks over days/weeks.
class BoundedCache {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // Re-insert to move this key to the end (most-recently-used) — Map
    // iterates/evicts in insertion order.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { BoundedCache };
