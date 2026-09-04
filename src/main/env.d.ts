/**
 * tsconfig.node.json types 'node' and 'electron-vite/node', neither of which
 * declares Vite's `?raw` asset suffix — the renderer gets it from
 * 'vite/client'. Main imports exactly one raw asset (the UI dictionary in
 * src/main/app/i18n.ts), so the one declaration lives here rather than
 * pulling vite/client's DOM-flavoured ambient types into the node project.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
