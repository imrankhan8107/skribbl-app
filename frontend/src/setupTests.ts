import "@testing-library/jest-dom";

// Polyfill localStorage if missing or incomplete in jsdom
if (typeof window !== "undefined") {
  const storage: Record<string, string> = {};
  const localStorageMock: Storage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = String(value);
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      Object.keys(storage).forEach((k) => delete storage[k]);
    },
    key: (index: number) => Object.keys(storage)[index] ?? null,
    get length() {
      return Object.keys(storage).length;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    writable: true,
  });
}
