import { useEffect, useState } from 'react';
import { newEntryId, type Glossary, type GlossaryEntry } from '@core/glossary/types';
import { api, errMsg } from '../api';
import { Toggle } from '../components/ui';

const split = (s: string) => s.split(/[;；,，、]/).map((x) => x.trim()).filter(Boolean);

export function GlossaryPage() {
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

  const entries = (draft?.entries ?? []).filter((e) => !filter || [e.zh, e.es, e.note, ...e.aliasesZh, ...e.aliasesEs].some((x) => x.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div>
      <h1 className="page-title">术语表</h1>
      <p className="page-sub">公司名、产品名、人名和行业词的固定译法。会用于：语音识别热词、识别纠错（别名 → 正确写法，支持拼音近音纠错）、翻译时强制使用、纪要里的正确写法。</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={selected} onChange={(e) => select(e.target.value)}>
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
        {draft && (
          <button className="btn" onClick={() => void api.glossary.exportCsv(draft.id)}>
            导出 CSV
          </button>
        )}
        {msg && <span className="muted small">{msg}</span>}
      </div>
      {draft && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row">
              <input type="text" value={draft.name} onChange={(e) => update((g) => (g.name = e.target.value))} />
              <Toggle checked={draft.enabled} onChange={(v) => update((g) => (g.enabled = v))} label="启用" />
              <input type="text" placeholder="搜索…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="row">
              <button className="btn" onClick={removeGlossary}>
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
                <th>Español</th>
                <th>中文别名（常被识别成）</th>
                <th>西语别名</th>
                <th>备注</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <input type="checkbox" checked={e.enabled} onChange={(ev) => setEntry(e.id, { enabled: ev.target.checked })} />
                  </td>
                  <td>
                    <input type="text" value={e.zh} onChange={(ev) => setEntry(e.id, { zh: ev.target.value })} />
                  </td>
                  <td>
                    <input type="text" value={e.es} onChange={(ev) => setEntry(e.id, { es: ev.target.value })} />
                  </td>
                  <td>
                    <input type="text" value={e.aliasesZh.join('；')} placeholder="用；分隔" onChange={(ev) => setEntry(e.id, { aliasesZh: split(ev.target.value) })} />
                  </td>
                  <td>
                    <input type="text" value={e.aliasesEs.join('; ')} onChange={(ev) => setEntry(e.id, { aliasesEs: split(ev.target.value) })} />
                  </td>
                  <td>
                    <input type="text" value={e.note} onChange={(ev) => setEntry(e.id, { note: ev.target.value })} />
                  </td>
                  <td>
                    <button className="btn ghost sm" title="删除" onClick={() => update((g) => (g.entries = g.entries.filter((x) => x.id !== e.id)))}>
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
            onClick={() => update((g) => g.entries.push({ id: newEntryId(), zh: '', es: '', aliasesZh: [], aliasesEs: [], note: '', enabled: true }))}
          >
            + 添加术语
          </button>
          <p className="hint">导入格式：CSV（Excel 另存为“CSV UTF-8”），列为 中文, Español, 中文别名, 西语别名, 备注；也可以直接从 Excel 复制两列粘贴成文本文件导入。</p>
        </div>
      )}
    </div>
  );
}
