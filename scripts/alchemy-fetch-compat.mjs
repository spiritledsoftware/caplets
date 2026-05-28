const fetchCompatInstalled = Symbol.for("caplets.alchemyFetchCompatInstalled");

if (!globalThis[fetchCompatInstalled]) {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    if (init && typeof init === "object" && "dispatcher" in init) {
      const { dispatcher: _dispatcher, ...compatibleInit } = init;
      return nativeFetch(input, compatibleInit);
    }

    return nativeFetch(input, init);
  };

  Object.defineProperty(globalThis, fetchCompatInstalled, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
