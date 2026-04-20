import { Buffer } from "buffer";

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (typeof globalScope.Buffer === "undefined") {
  globalScope.Buffer = Buffer;
}

if (typeof globalScope.global === "undefined") {
  globalScope.global = globalThis;
}

if (typeof globalThis.process === "undefined") {
  (globalThis as any).process = { env: {} };
}
