// Module resolution hook: the Firebase CDN is not reachable from tests, so its
// specifiers resolve to the in-memory stub instead. Everything else is untouched.
const stub = new URL('./firebase-sdk-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('https://www.gstatic.com/firebasejs/')) {
    return { url: stub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
