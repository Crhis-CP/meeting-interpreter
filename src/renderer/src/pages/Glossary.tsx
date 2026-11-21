import { useEffect, useRef, useState } from 'react';
import { newEntryId, type Glossary, type GlossaryEntry } from '@core/glossary/types';
import { api, errMsg, useLlmReady, useSettings } from '../api';
import { AccentCalibrationCard, MyCorrectionsCard } from '../components/AccentCard';
import { glossaryToCsv } from '@core/glossary/csv';
import { lang } from '@core/lang/languages';
import { Toggle } from '../components/ui';

const split = (s: string) => s.split(/[;；,，、]/).map((x) => x.trim()).filter(Boolean);

/**
 * A list typed as text ("报价；报价单", "plazo de entrega; entrega"): the text is kept as typed and
 * split only when the field is left, so separators and spaces can be typed normally.
 */
function ListInput({ value, sep, label, onChange }: { value: string[]; sep: string; label: string; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(sep));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value.join(sep));
  }, [value, sep, editing]);
  return (
    <input
      type="text"
      aria-label={label}
      value={text}
      placeholder={sep.trim()}
      onFocus={() => setEditing(true)}
      onChange={(ev) => setText(ev.target.value)}
      onBlur={() => {
        setEditing(false);
        onChange(split(text));
      }}
    />
  );
}

type WordsTab = 'terms' | 'fixes' | 'accent';
const WORDS_TABS: [WordsTab, string][] = [
  ['terms', '术语'],
  ['fixes', '纠错'],
  ['accent', '口音校准'],
];

/**
 * 词库: everything the app learns or is told about words, in one place — terms (fixed
 * translations, with what each is often heard as), corrections ("heard as → really"), and accent
 * calibration. (Before 0.9 these were spread over the 术语表 page and two settings tabs.)
 */
export function WordsPage({ go }: { go?: (page: 'settings') => void }) {
  const [s, update] = useSettings();
  const llmReady = useLlmReady(s);
  const [tab, setTab] = useState<WordsTab>(() => {
    const asked = sessionStorage.getItem('words-tab') as WordsTab | null;
    sessionStorage.removeItem('words-tab');
    return asked && WORDS_TABS.some(([k]) => k === asked) ? asked : 'terms';
  });
  if (!s) return null;
  const toKeys = () => {
    sessionStorage.setItem('settings-tab', 'providers');
    go?.('settings');
  };
  return (
    <div>
      <h1 className="page-title">词库</h1>
      <div className="tabs" role="tablist" aria-label="词库">
        {WORDS_TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'terms' && <GlossaryPage />}
      {tab === 'fixes' && (
        <>
          <div className="card">
            <h3>按读音纠正</h3>
            <Toggle checked={s.interpretation.pinyinFuzzy} onChange={(v) => void update({ interpretation: { pinyinFuzzy: v } })} label="听成读音相近的字时，改成术语表里的词" />
            <div className="muted small" style={{ marginTop: 6 }}>会结合你的口音特点（口音校准和你的改正里学到的）。术语各自“常被听成”的写法在“术语”页里。</div>
          </div>
          <MyCorrectionsCard s={s} update={update} llmReady={llmReady ?? true} setTab={toKeys} />
        </>
      )}
      {tab === 'accent' && <AccentCalibrationCard s={s} update={update} />}
    </div>
  );
}

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
  // Edits are never lost: switching glossaries, importing or leaving the page saves them first.
  const pending = useRef<Glossary | null>(null);
  pending.current = dirty ? draft : null;
  useEffect(() => () => void (pending.current && api.glossary.save(pending.current)), []);
  const flush = async () => {
    const g = pending.current;
    if (!g) return;
    pending.current = null;
    setList(await api.glossary.save(g));
    setDirty(false);
  };

  useEffect(() => {
    void api.glossary.list().then((l) => {
      setList(l);
      if (l[0]) {
        setSelected(l[0].id);
        setDraft(structuredClone(l[0]));
      }
    });
  }, []);

  const select = async (id: string) => {
    await flush();
    const g = (await api.glossary.list()).find((x) => x.id === id);
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
    await flush();
    const g: Glossary = { id: `g${Date.now().toString(36)}`, name: '新术语表', enabled: true, entries: [] };
    const l = await api.glossary.save(g);
    setList(l);
    setSelected(g.id);
    setDraft(structuredClone(g));
  };

  const importCsv = async () => {
    try {
      await flush();
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
    // Its unsaved edits go with it (never saved back after the delete).
    pending.current = null;
    setDirty(false);
    const l = await api.glossary.remove(draft.id);
    setList(l);
    if (l[0]) select(l[0].id);
  };

  const entries = (draft?.entries ?? []).filter((e) => !filter || [e.zh, e.es, e.en ?? '', e.note, ...e.aliasesZh, ...e.aliasesEs, ...(e.aliasesEn ?? [])].some((x) => x.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div>
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
                    <ListInput label="中文常被听成" sep="；" value={e.aliasesZh} onChange={(v) => setEntry(e.id, { aliasesZh: v })} />
                  </td>
                  <td>
                    {en ? (
                      <ListInput label="English 常被听成" sep="; " value={e.aliasesEn ?? []} onChange={(v) => setEntry(e.id, { aliasesEn: v })} />
                    ) : (
                      <ListInput label="Español 常被听成" sep="; " value={e.aliasesEs} onChange={(v) => setEntry(e.id, { aliasesEs: v })} />
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
