export {};

declare global {
  // Allow BASE_URL to be set on globalThis for Bun/Node test context
  // eslint-disable-next-line no-var
  var BASE_URL: string;
}
