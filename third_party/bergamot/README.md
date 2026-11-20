# Bergamot translator (Firefox Translations engine)

`bergamot-translator.wasm` and its JS glue `bergamot-translator.js` are the offline translation
engine Firefox uses (Mozilla, MPL-2.0, see LICENSE). Taken unmodified from:

- wasm: Firefox Remote Settings, collection `translations-wasm`, record “bergamot-translator” 3.0
  (`main-workspace/translations-wasm/05082c31-aee8-4249-9e01-c1865afd7520.wasm`)
- glue: https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/bergamot-translator/bergamot-translator.js

The translation models (also MPL-2.0, from https://github.com/mozilla/translations) are not stored
here; the apps download them on first use (see `src/browser/offline-mt/manifest.json`).
