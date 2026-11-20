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

describe('everyday Argentine Spanish before offline translation', () => {
  it('turns interjections and set phrases into plain Spanish the models know', async () => {
    const { plainSpanish } = await import('@core/providers/offline-translator');
    expect(plainSpanish('Che, ¿vos sabés si el precio incluye el flete?')).toBe('¿vos sabés si el precio incluye el flete?');
    expect(plainSpanish('Dale, lo charlamos con el equipo.')).toBe('De acuerdo, lo charlamos con el equipo.');
    expect(plainSpanish('Listo, te mando el contrato hoy.')).toBe('Bien, te mando el contrato hoy.');
    expect(plainSpanish('Bárbaro, nos vemos el martes.')).toBe('Genial, nos vemos el martes.');
    expect(plainSpanish('Ojo, el precio no incluye IVA.')).toBe('Atención, el precio no incluye IVA.');
    expect(plainSpanish('El precio está re caro.')).toBe('El precio está muy caro.');
    expect(plainSpanish('Está caro, ¿viste? No sé.')).toBe('Está caro. No sé.');
    expect(plainSpanish('Nos parece bien, pero necesitamos garantía.')).toBe('Estamos de acuerdo, pero necesitamos garantía.');
    expect(plainSpanish('Me parece bien.')).toBe('Estoy de acuerdo.');
    expect(plainSpanish('Es mucho laburo.')).toBe('Es mucho trabajo.');
    expect(plainSpanish('¿Me pasás tu WhatsApp? Pasame el contrato.')).toBe('¿Me das tu WhatsApp? Dame el contrato.');
  });

  it('leaves the same words alone where they mean something else', async () => {
    const { plainSpanish } = await import('@core/providers/offline-translator');
    for (const s of ['Dale el catálogo a Juan.', 'Nos parece bien el precio.', 'El pedido está listo para enviar.', 'Tengo un ojo rojo.', 'Fue una reunión bárbara y larga.', '¿Me pasás a buscar a las ocho?', '¿Listo? Empezamos.']) expect(plainSpanish(s)).toBe(s);
  });

  it('applies only to Spanish sources', async () => {
    const seen: string[] = [];
    const t = new OfflineTranslator({ translate: async (text) => (seen.push(text), 'x') });
    await t.translate({ text: 'Dale, perfecto.', from: 'es-AR', to: 'zh-CN', hits: [], context: [] });
    await t.translate({ text: 'Dale, perfect.', from: 'en-US', to: 'zh-CN', hits: [], context: [] });
    expect(seen).toEqual(['De acuerdo, perfecto.', 'Dale, perfect.']);
  });
});
