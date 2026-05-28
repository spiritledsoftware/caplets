const fetchCompatInstalled = Symbol.for("caplets.alchemyFetchCompatInstalled");
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };
const globalSymbols = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;

if (!globalSymbols[fetchCompatInstalled]) {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const compatibleInit = init as FetchInitWithDispatcher | undefined;
    if (compatibleInit && "dispatcher" in compatibleInit) {
      const { dispatcher: _dispatcher, ...requestInit } = compatibleInit;
      return nativeFetch(input, requestInit);
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
