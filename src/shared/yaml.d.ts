/**
 * A `.yaml` import is the file's parsed value, made when the module is built
 * (`scripts/lib/yaml-module.mjs`). Main and the window each import one, the UI
 * dictionary (`app/i18n.ts`, `lib/i18n.ts`), and read it through a parser
 * such as `asUiDict`, never trusted as typed.
 */
declare module '*.yaml' {
  const value: unknown;
  export default value;
}
