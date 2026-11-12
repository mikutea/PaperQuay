// PDF.js needs this method in both the reader and its worker on older WebViews.
if (typeof Promise.withResolvers !== 'function') {
  Reflect.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers() {
      let resolve;
      let reject;
      const promise = new this((fulfill, fail) => {
        if (resolve !== undefined || reject !== undefined) {
          throw new TypeError('Promise callbacks already initialized');
        }
        resolve = fulfill;
        reject = fail;
      });
      if (typeof resolve !== 'function' || typeof reject !== 'function') {
        throw new TypeError('Invalid Promise callbacks');
      }
      return { promise, resolve, reject };
    },
  });
}
