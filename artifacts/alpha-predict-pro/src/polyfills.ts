import { Buffer } from "buffer";

const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string | undefined> };
};

if (typeof globalScope.Buffer === "undefined") {
  globalScope.Buffer = Buffer;
}

if (typeof globalScope.global === "undefined") {
  globalScope.global = globalThis;
}

if (typeof globalScope.process === "undefined") {
  globalScope.process = { env: {} };
}
