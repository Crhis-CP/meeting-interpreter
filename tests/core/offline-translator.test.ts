import { describe, expect, it } from 'vitest';
import { OfflineTranslator } from '@core/providers/offline-translator';
import { routeFor } from '../../src/browser/offline-mt/engine';

describe('offline translation', () => {
  it('routes Chinese ⇄ Spanish through English and the rest directly', () => {
    expect(routeFor('zh', 'es')).toEqual(['zh-en', 'en-es']);
    expect(routeFor('es', 'zh')).toEqual(['es-en', 'en-zh']);
    expect(routeFor('zh', 'en')).toEqual(['zh-en']);
    expect(routeFor('en', 'zh')).toEqual(['en-zh']);
  });

  it('keeps glossary terms as the user wrote them', async () => {
    const seen: string[] = [];
    const t = new OfflineTranslator({ translate: async (text, from, to) => (seen.push(`${from}>${to}:${text}`), 'Presentamos Plataforma Nébula.') });
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true };
    const out = await t.translate({ text: '我们介绍一下星云平台。', from: 'zh-CN', to: 'es-MX', hits: [{ source: '星云平台', target: 'Plataforma Nébula', entry }], context: [] });
    expect(seen).toEqual(['zh>es:我们介绍一下Plataforma Nébula。']);
    expect(out).toBe('Presentamos Plataforma Nébula.');
  });
});
