/* Offline translation worker: runs Mozilla's Bergamot engine (Firefox Translations).
 * Messages: {id, op: 'init', args: {wasm, glueUrl}} | {id, op: 'load', args: {pair, files}}
 *           | {id, op: 'translate', args: {route: ['zh-en','en-es'], text}} → {id, result | error} */
let bergamot = null;
let service = null;
const models = {};
const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
const config = (o) => '\n' + Object.entries(o).map(([k, v]) => `            ${k}: ${v}\n`).join('') + '            ';
const memory = (buf, align) => {
  const m = new bergamot.AlignedMemory(buf.byteLength, align);
  m.getByteArrayView().set(new Uint8Array(buf));
  return m;
};

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    let result = null;
    if (op === 'init') {
      if (!bergamot) {
        importScripts(args.glueUrl);
        bergamot = await new Promise((resolve, reject) => {
          const b = loadBergamot({
            INITIAL_MEMORY: 41943040,
            print: () => {},
            onAbort: () => reject(new Error('翻译引擎加载失败')),
            onRuntimeInitialized: async () => {
              await Promise.resolve();
              resolve(b);
            },
            wasmBinary: args.wasm,
          });
        });
        service = new bergamot.BlockingService({ cacheSize: 0 });
      }
    } else if (op === 'load') {
      const { pair, files } = args;
      const [from, to] = pair.split('-');
      const vocabs = new bergamot.AlignedMemoryList();
      if (files.vocab) vocabs.push_back(memory(files.vocab, ALIGN.vocab));
      else {
        vocabs.push_back(memory(files.srcvocab, ALIGN.srcvocab));
        vocabs.push_back(memory(files.trgvocab, ALIGN.trgvocab));
      }
      models[pair] = new bergamot.TranslationModel(
        from,
        to,
        config({ 'beam-size': 1, normalize: '1.0', 'word-penalty': 0, 'max-length-break': 128, 'mini-batch-words': 1024, workspace: 128, 'max-length-factor': '2.0', 'skip-cost': 'true', 'cpu-threads': 0, quiet: 'true', 'quiet-translation': 'true', 'gemm-precision': 'int8shiftAlphaAll', alignment: 'soft' }),
        memory(files.model, ALIGN.model),
        memory(files.lex, ALIGN.lex),
        vocabs,
        null,
      );
    } else if (op === 'translate') {
      const ms = args.route.map((k) => models[k]);
      if (ms.some((m) => !m)) throw new Error('离线翻译模型还没有加载');
      const msgs = new bergamot.VectorString();
      msgs.push_back(args.text);
      const opts = new bergamot.VectorResponseOptions();
      opts.push_back({ qualityScores: false, alignment: false, html: false });
      const r = ms.length === 1 ? service.translate(ms[0], msgs, opts) : service.translateViaPivoting(ms[0], ms[1], msgs, opts);
      result = r.get(0).getTranslatedText();
      msgs.delete();
      opts.delete();
      r.delete();
    }
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
