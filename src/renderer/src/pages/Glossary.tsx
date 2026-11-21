import { useEffect, useState } from 'react';
import { newEntryId, type Glossary, type GlossaryEntry } from '@core/glossary/types';
import { api, errMsg, useSettings } from '../api';
import { glossaryToCsv } from '@core/glossary/csv';
import { lang } from '@core/lang/languages';
import { Toggle } from '../components/ui';

const split = (s: string) => s.split(/[;；,，、]/).map((x) => x.trim()).filter(Boolean);

export function GlossaryPage() {
  const [settings] = useSettings();
  // Only the language now translated to is shown (the other one's terms are kept).
  const en = !!settings && lang(settings.languages.remote).base === 'en';
  const [list, setList] = useState<Glossary[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [draft, setDraft] = useState<Glossary | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void api.glossary.list().then((l) => {
      setList(l);
      if (l[0]) {
        setSelected(l[0].id);
        setDraft(structuredClone(l[0]));
      }
    });
  }, []);

  const select = (id: string) => {
    const g = list.find((x) => x.id === id);
    if (!g) return;
    setSelected(id);
    setDraft(structuredClone(g));
    setDirty(false);
  };

  const save = async (g = draft) => {
    if (!g) return;
    const l = await api.glossary.save(g);
    setList(l);
    setDirty(false);
    setMsg('已保存，下一句话起生效');
    setTimeout(() => setMsg(''), 2500);
  };

  const update = (fn: (g: Glossary) => void) => {
    if (!draft) return;
    const g = structuredClone(draft);
    fn(g);
    setDraft(g);
    setDirty(true);
  };

  const setEntry = (id: string, patch: Partial<GlossaryEntry>) =>
    update((g) => {
      const e = g.entries.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
    });

  const addGlossary = async () => {
    const g: Glossary = { id: `g${Date.now().toString(36)}`, name: '新术语表', enabled: true, entries: [] };
    const l = await api.glossary.save(g);
    setList(l);
    setSelected(g.id);
    setDraft(structuredClone(g));
  };

  const importCsv = async () => {
    try {
      const res = await api.glossary.importCsv(draft?.id ?? null);
      if (!res) return;
      setList(res.glossaries);
      const g = res.glossaries.find((x) => x.id === draft?.id) ?? res.glossaries[res.glossaries.length - 1];
      if (g) {
        setSelected(g.id);
        setDraft(structuredClone(g));
      }
      setMsg(`导入 ${res.imported} 条${res.errors.length ? `，${res.errors.length} 行有问题：${res.errors.slice(0, 3).map((e) => `第 ${e.line} 行 ${e.message}`).join('；')}` : ''}`);
    } catch (err) {
      setMsg(errMsg(err));
    }
  };

  const removeGlossary = async () => {
    if (!draft || !confirm(`删除术语表“${draft.name}”？`)) return;
    const l = await api.glossary.remove(draft.id);
    setList(l);
    if (l[0]) select(l[0].id);
  };

  const entries = (draft?.entries ?? []).filter((e) => !filter || [e.zh, e.es, e.en ?? '', e.note, ...e.aliasesZh, ...e.aliasesEs, ...(e.aliasesEn ?? [])].some((x) => x.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div>
      <h1 className="page-title">术语表</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={selected} onChange={(e) => select(e.target.value)} aria-label="术语表">
          {list.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}（{g.entries.length}）{g.enabled ? '' : ' · 未启用'}
            </option>
          ))}
        </select>
        <button className="btn" onClick={addGlossary}>
          新建术语表
        </button>
        <button className="btn" onClick={importCsv}>
          导入 CSV / Excel
        </button>
        <a className="btn" href={`data:text/csv;charset=utf-8,${encodeURIComponent(glossaryToCsv([]))}`} download="术语表模板.csv">
          下载模板
        </a>
        {draft && (
          <button className="btn" onClick={() => void api.glossary.exportCsv(draft.id)}>
            导出 CSV
          </button>
        )}
        {msg && <span className="muted small" role="status">{msg}</span>}
      </div>
      {draft && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row">
              <input type="text" value={draft.name} aria-label="术语表名称" onChange={(e) => update((g) => (g.name = e.target.value))} />
              <Toggle checked={draft.enabled} onChange={(v) => update((g) => (g.enabled = v))} label="启用" />
              <input type="search" placeholder="搜索" aria-label="搜索术语" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="row">
              <button data-test="destructive" className="btn" onClick={removeGlossary}>
                删除术语表
              </button>
              <button className="btn primary" onClick={() => void save()} disabled={!dirty}>
                保存
              </button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>启用</th>
                <th>中文</th>
                <th>{en ? 'English' : 'Español'}</th>
                <th>中文常被听成</th>
                <th>{en ? 'English' : 'Español'} 常被听成</th>
                <th>备注</th>
                <th style={{ width: 40 }}><span className="sr-only">删除</span></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <input type="checkbox" aria-label={`启用 ${e.zh}`} checked={e.enabled} onChange={(ev) => setEntry(e.id, { enabled: ev.target.checked })} />
                  </td>
                  <td>
                    <input type="text" aria-label="中文" value={e.zh} onChange={(ev) => setEntry(e.id, { zh: ev.target.value })} />
                  </td>
                  <td>
                    {en ? (
                      <input type="text" aria-label="English" value={e.en ?? ''} onChange={(ev) => setEntry(e.id, { en: ev.target.value })} />
                    ) : (
                      <input type="text" aria-label="Español" value={e.es} onChange={(ev) => setEntry(e.id, { es: ev.target.value })} />
                    )}
                  </td>
                  <td>
                    <input type="text" aria-label="中文常被听成" value={e.aliasesZh.join('；')} placeholder="；" onChange={(ev) => setEntry(e.id, { aliasesZh: split(ev.target.value) })} />
                  </td>
                  <td>
                    {en ? (
                      <input type="text" aria-label="English 常被听成" value={(e.aliasesEn ?? []).join('; ')} onChange={(ev) => setEntry(e.id, { aliasesEn: split(ev.target.value) })} />
                    ) : (
                      <input type="text" aria-label="Español 常被听成" value={e.aliasesEs.join('; ')} onChange={(ev) => setEntry(e.id, { aliasesEs: split(ev.target.value) })} />
                    )}
                  </td>
                  <td>
                    <input type="text" aria-label="备注" value={e.note} onChange={(ev) => setEntry(e.id, { note: ev.target.value })} />
                  </td>
                  <td>
                    <button data-test="safe" className="btn ghost sm" aria-label={`删除 ${e.zh || '这条术语'}`} onClick={() => update((g) => (g.entries = g.entries.filter((x) => x.id !== e.id)))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="btn"
            style={{ marginTop: 10 }}
            onClick={() => update((g) => g.entries.push({ id: newEntryId(), zh: '', es: '', en: '', aliasesZh: [], aliasesEs: [], aliasesEn: [], note: '', enabled: true }))}
          >
            + 添加术语
          </button>
        </div>
      )}
    </div>
  );
}
