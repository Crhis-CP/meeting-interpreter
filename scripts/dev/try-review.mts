// The after-meeting review against a real LLM (智谱 free; key injected by the environment, or MI_LLM_KEY).
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { createLogger } from '../../src/core/log';
import { parseSettings } from '../../src/core/config/schema';
import { makeLlm } from '../../src/core/providers/registry';
import { createNodeContext } from '../../src/main/platform/node-context';
import { reviewMeeting } from '../../src/core/profile/review';
import type { TranscriptSegment } from '../../src/core/types';
setGlobalDispatcher(new EnvHttpProxyAgent());
const ctx = createNodeContext(createLogger('t'), (i, init) => fetch(i, init));
const llm = makeLlm(parseSettings({ preset: 'custom', llm: { preset: 'zhipu-free', baseUrl: '', model: '' } }), { llm: process.env.MI_LLM_KEY || 'proxy-injected' }, ctx)!;
let n = 0;
const seg = (dir: 'out' | 'in', src: string, dst: string): TranscriptSegment => ({ id: `${dir}-${++n}`, dir, speaker: dir === 'out' ? 'me' : 'them', seq: n, start: n, end: n + 1, srcLang: dir === 'out' ? 'zh-CN' : 'es-AR', dstLang: dir === 'out' ? 'es-AR' : 'zh-CN', srcText: src, dstText: dst, status: 'done' });
const segs = [
  seg('out', '大家好，今天主要介绍我们的星云平台。', 'Hola a todos, hoy presentamos nuestra Plataforma Nébula.'),
  seg('in', '¿La Plataforma Nébula funciona con la red de Mercado Libre?', '星云平台能和美客多的网络一起用吗？'),
  seg('out', '可以，星云平太已经和美客多对接了。', 'Sí, la Plataforma Nébula ya está integrada con Mercado Libre.'),
  seg('out', '我们下周把河同发给你们，付款方式是百分之三十预付。', 'La próxima semana les enviamos el contrato, el pago es 30% por adelantado.'),
  seg('in', 'Perfecto, y el flete hasta Rosario corre por nuestra cuenta.', '好的，到罗萨里奥的运费由我们承担。'),
  seg('out', '好的，运费你们负责，交货期三周。', 'De acuerdo, el flete corre por su cuenta; el plazo de entrega es de tres semanas.'),
];
const t0 = Date.now();
const r = await reviewMeeting(llm, segs, { terms: [], foreign: 'es' });
console.log(`${Date.now() - t0} ms`);
console.log(JSON.stringify(r, null, 1));
