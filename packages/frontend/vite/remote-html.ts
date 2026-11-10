/** True when Vite is transforming the isolated listener remote MPA entry. */
export function isListenerRemoteHtml(ctx: { filename?: string; path?: string }): boolean {
  return Boolean(
    ctx.filename?.endsWith('remote.html')
    || ctx.path === '/remote.html'
    || ctx.path === '/remote'
    || ctx.path === '/remote/',
  );
}
