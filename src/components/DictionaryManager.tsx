import { useMemo, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Search,
  BookmarkPlus,
  X,
  ClipboardPaste,
  Check,
  FileSpreadsheet,
  Upload,
  Download,
  AlertTriangle
} from 'lucide-react';
import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import type { GlossaryList } from '../data/glossaryRepo';
import {
  MAX_IMPORT_TERM_LENGTH,
  parseGlossaryFile,
  toGlossaryFile,
  type GlossaryImportResult
} from '../data/glossaryImport';

// The glossary belongs to this project and is stored in the database — it
// follows the operator to any device, not just this browser. These
// sections are exactly what GlossarySections (src/glossary.ts) and the
// Gemini prompt-building code understand; adding another here would not
// correspond to anything else in the pipeline.
const SECTIONS: Array<{ key: GlossarySection; label: string; hint: string }> = [
  { key: 'protected_terms', label: 'ศัพท์เฉพาะ', hint: 'ไทย → อังกฤษ: คำที่ต้องคงคำแปลไว้เสมอ เช่น ความดันโลหิตสูง → hypertension' },
  { key: 'person_names', label: 'ชื่อบุคคล', hint: 'ไทย → อังกฤษ: ชื่อผู้พูดที่ถอดเสียงเป็นอังกฤษ เช่น นพ. สมชาย → Dr. Somchai' },
  { key: 'thai_corrections', label: 'แก้คำไทยที่ฟังผิด', hint: 'ไทย → ไทย: แก้คำที่ระบบมักได้ยินผิด เช่น ยาพารา → ยาพาราเซตามอล' },
  {
    key: 'en_th_corrections',
    label: 'แก้คำอังกฤษเป็นไทย',
    hint: 'อังกฤษ → ไทย: แก้คำทับศัพท์ที่ค้างอยู่ในคำแปลไทย เช่น Kawin → กวิน (ใช้เมื่อแปลเป็นภาษาไทย และแทนที่ให้แน่นอนทุกครั้ง)'
  }
];

export interface DictionaryManagerProps {
  sections: GlossarySections | null;
  /** Reusable lists maintained by an admin. Selecting one merges its terms
   *  into this project; its contents cannot be edited here. */
  sharedLists: GlossaryList[];
  subscribedIds: Set<string>;
  onToggleList: (listId: string) => void;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  /** Writes a whole parsed file in one go. Separate from `onAdd` because an
   *  import of a hundred names must be one statement, not a hundred. */
  onAddMany: (sections: GlossarySections) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
  /** True when `term` in `section` resolves from the project's own list — as
   *  opposed to a subscribed shared list, which `onRemove` cannot touch (it
   *  always targets the project's own list, so deleting a shared-origin term
   *  would match zero rows and just reappear on the next merge). */
  isOwnTerm: (section: GlossarySection, term: string) => boolean;
  disabled: boolean;
}

export default function DictionaryManager({
  sections,
  sharedLists,
  subscribedIds,
  onToggleList,
  onAdd,
  onAddMany,
  onRemove,
  isOwnTerm,
  disabled
}: DictionaryManagerProps) {
  const [activeSection, setActiveSection] = useState<GlossarySection>('protected_terms');
  const [searchQuery, setSearchQuery] = useState('');
  const [newTerm, setNewTerm] = useState('');
  const [newEquivalent, setNewEquivalent] = useState('');
  const newTermInputRef = useRef<HTMLInputElement>(null);

  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteRawText, setPasteRawText] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // The parsed file waiting for a confirm, plus the name it came from. Held
  // rather than applied on selection: an import overwrites terms, so the
  // operator sees what it will do before it does it.
  const [pendingImport, setPendingImport] = useState<GlossaryImportResult | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeMeta = SECTIONS.find((s) => s.key === activeSection)!;
  const entries = useMemo(() => Object.entries(sections?.[activeSection] ?? {}), [sections, activeSection]);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.trim().toLowerCase();
    return entries.filter(([term, equivalent]) => term.toLowerCase().includes(q) || equivalent.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2000);
  };

  const handleAddRow = () => {
    const term = newTerm.trim();
    const equivalent = newEquivalent.trim();
    if (!term || !equivalent) return;
    onAdd(activeSection, term, equivalent);
    setNewTerm('');
    setNewEquivalent('');
    newTermInputRef.current?.focus();
  };

  const handleDeleteRow = (term: string) => {
    onRemove(activeSection, term);
  };

  // Two-column paste from a spreadsheet: one row per line, columns separated
  // by a tab (Excel/Sheets default) or, failing that, two or more spaces.
  const parsedPasteRows = useMemo(() => {
    return pasteRawText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/);
        return { term: (parts[0] ?? '').trim(), equivalent: (parts[1] ?? '').trim() };
      })
      .filter((row) => row.term && row.equivalent);
  }, [pasteRawText]);

  const handleConfirmPaste = () => {
    // One write for the whole paste, same path an import takes.
    const pasted = emptyGlossary();
    for (const row of parsedPasteRows) pasted[activeSection][row.term] = row.equivalent;
    onAddMany(pasted);
    showToast(`เพิ่ม ${parsedPasteRows.length} คำในหมวด "${activeMeta.label}" แล้ว`);
    setPasteRawText('');
    setShowPasteModal(false);
  };

  // ── JSON import / export ───────────────────────────────────────────────
  const handleFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so picking the SAME file twice in a row still fires
    // a change event — the second attempt is usually a corrected file.
    event.target.value = '';
    if (!file) return;
    setImportFileName(file.name);
    try {
      setPendingImport(parseGlossaryFile(await file.text(), activeSection));
    } catch {
      setPendingImport({ status: 'error', error: 'อ่านไฟล์ไม่สำเร็จ' });
    }
  };

  const handleConfirmImport = () => {
    if (pendingImport?.status !== 'ok') return;
    onAddMany(pendingImport.sections);
    showToast(`นำเข้า ${pendingImport.total} คำแล้ว`);
    setPendingImport(null);
    setImportFileName('');
  };

  const handleExport = () => {
    // Exports everything the operator can SEE, which includes terms coming
    // from subscribed shared lists. That is the point: the file is a
    // snapshot of the glossary this project actually translates with, and
    // it stays usable even if a shared list changes later.
    const text = toGlossaryFile(sections ?? emptyGlossary());
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `glossary-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('ดาวน์โหลดไฟล์ glossary แล้ว');
  };

  const totalTermsShown = useMemo(
    () => SECTIONS.reduce((sum, s) => sum + Object.keys(sections?.[s.key] ?? {}).length, 0),
    [sections]
  );

  return (
    <div className="space-y-3.5">
      {sharedLists.length > 0 && (
        <div className="mb-3 pb-3 border-b border-slate-200">
          <p className="text-[11px] font-semibold text-slate-500 mb-1.5">คลังคำศัพท์ที่ใช้ร่วมกัน</p>
          <div className="flex flex-col gap-1">
            {sharedLists.map((list) => (
              <label
                key={list.id}
                className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={subscribedIds.has(list.id)}
                  disabled={disabled}
                  onChange={() => onToggleList(list.id)}
                />
                <span className="min-w-0">
                  <span className="font-medium">{list.name}</span>
                  {list.description && (
                    <span className="block text-[11px] text-slate-500">{list.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            แก้ไขคลังที่ใช้ร่วมกันได้จากผู้ดูแลระบบเท่านั้น — คำที่เพิ่มด้านล่างจะอยู่กับโปรเจกต์นี้
            และจะทับคำในคลังที่ชื่อซ้ำกัน
          </p>
        </div>
      )}

      {/* Section tabs */}
      <div className="grid grid-cols-2 gap-1 p-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px]">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveSection(s.key)}
            className={`py-1.5 px-1 rounded-md font-semibold transition-all ${
              activeSection === s.key ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed -mt-1">{activeMeta.hint}</p>

      {/* Search + paste-from-Excel */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ค้นหาคำในหมวดนี้..."
            className="w-full pl-8 pr-2.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E]"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowPasteModal(true)}
          disabled={disabled}
          title="วางจาก Excel/Sheets สองคอลัมน์"
          className="p-2 bg-slate-50 hover:bg-pink-50 hover:text-[#DE5C8E] border border-slate-200 rounded-lg text-slate-500 transition-all disabled:opacity-40"
        >
          <ClipboardPaste className="w-4 h-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFilePicked}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="นำเข้าคำศัพท์จากไฟล์ .json"
          className="p-2 bg-slate-50 hover:bg-pink-50 hover:text-[#DE5C8E] border border-slate-200 rounded-lg text-slate-500 transition-all disabled:opacity-40"
        >
          <Upload className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={totalTermsShown === 0}
          title="ดาวน์โหลดคำศัพท์ทั้งหมดเป็นไฟล์ .json"
          className="p-2 bg-slate-50 hover:bg-pink-50 hover:text-[#DE5C8E] border border-slate-200 rounded-lg text-slate-500 transition-all disabled:opacity-40"
        >
          <Download className="w-4 h-4" />
        </button>
      </div>

      {/* Term list */}
      <div className="max-h-64 overflow-y-auto space-y-1.5 pr-0.5">
        {filteredEntries.length === 0 && (
          <p className="text-xs text-slate-400 text-center py-4">
            {entries.length === 0 ? 'ยังไม่มีคำในหมวดนี้' : 'ไม่พบคำที่ค้นหา'}
          </p>
        )}
        {filteredEntries.map(([term, equivalent]) => {
          const isOwn = isOwnTerm(activeSection, term);
          return (
            <div key={term} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs">
              <span className="flex-1 min-w-0 truncate font-semibold text-slate-800">{term}</span>
              <span className="text-slate-300 shrink-0">→</span>
              <span className="flex-1 min-w-0 truncate text-[#DE5C8E] font-medium">{equivalent}</span>
              <button
                type="button"
                onClick={() => handleDeleteRow(term)}
                disabled={disabled || !isOwn}
                className="p-1 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-all disabled:opacity-30 shrink-0"
                title={isOwn ? 'ลบคำนี้' : 'มาจากคลังคำศัพท์ที่ใช้ร่วมกัน — ลบไม่ได้ที่นี่'}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add a new row */}
      <div className="flex items-center gap-1.5 pt-1 border-t border-slate-100">
        <input
          ref={newTermInputRef}
          type="text"
          value={newTerm}
          onChange={(e) => setNewTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddRow()}
          disabled={disabled}
          placeholder="คำที่ได้ยิน"
          className="flex-1 min-w-0 p-2 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] disabled:opacity-50"
        />
        <input
          type="text"
          value={newEquivalent}
          onChange={(e) => setNewEquivalent(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddRow()}
          disabled={disabled}
          placeholder="คำที่ต้องการ"
          className="flex-1 min-w-0 p-2 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleAddRow}
          disabled={disabled || !newTerm.trim() || !newEquivalent.trim()}
          className="p-2 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg disabled:opacity-40 transition-all shrink-0"
          title="เพิ่มคำ"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Paste-from-Excel modal */}
      {showPasteModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-3.5">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-[#DE5C8E]" />
                <span>วางตารางสองคอลัมน์ — หมวด &ldquo;{activeMeta.label}&rdquo;</span>
              </h3>
              <button onClick={() => setShowPasteModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              คัดลอกสองคอลัมน์จาก Excel/Google Sheets แล้ววางที่นี่ (คอลัมน์ซ้าย = คำที่ได้ยิน, คอลัมน์ขวา = คำที่ต้องการ)
            </p>
            <textarea
              value={pasteRawText}
              onChange={(e) => setPasteRawText(e.target.value)}
              rows={8}
              placeholder={'ความดันโลหิตสูง\thypertension\nนพ. สมชาย\tDr. Somchai'}
              className="w-full p-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E]"
            />
            <p className="text-[11px] text-slate-400">ตรวจพบ {parsedPasteRows.length} แถวที่ถูกต้อง</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowPasteModal(false)}
                className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleConfirmPaste}
                disabled={parsedPasteRows.length === 0 || disabled}
                className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 disabled:opacity-40"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                <span>เพิ่มทั้งหมด</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import preview. An import overwrites terms that already exist, so
          nothing is written until the operator has seen the tally. */}
      {pendingImport && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-3.5">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <Upload className="w-4 h-4 text-[#DE5C8E]" />
                <span>นำเข้าคำศัพท์จากไฟล์</span>
              </h3>
              <button onClick={() => setPendingImport(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {importFileName && (
              <p className="text-[11px] text-slate-400 font-mono truncate">{importFileName}</p>
            )}

            {pendingImport.status !== 'ok' ? (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg space-y-2">
                <p className="text-xs text-rose-800 font-semibold">{pendingImport.error}</p>
                <div className="text-[11px] text-rose-700 space-y-1">
                  <p>รูปแบบที่รับได้มีสองแบบ:</p>
                  <pre className="bg-white/70 border border-rose-100 rounded-md p-2 overflow-x-auto font-mono leading-relaxed">
{`{ "Kawin": "กวิน" }

{ "en_th_corrections": { "Kawin": "กวิน" },
  "person_names": { "นพ. สมชาย": "Dr. Somchai" } }`}
                  </pre>
                </div>
              </div>
            ) : (
              <>
                <p className="text-xs text-slate-600">
                  {pendingImport.form === 'flat' ? (
                    <>
                      ไฟล์นี้ไม่ได้ระบุหมวด — จะนำเข้าทั้งหมดลงหมวด{' '}
                      <span className="font-bold text-[#DE5C8E]">{activeMeta.label}</span> ที่เปิดอยู่
                    </>
                  ) : (
                    <>ไฟล์นี้ระบุหมวดมาเอง — จะนำเข้าตามที่ไฟล์กำหนด</>
                  )}
                </p>

                <div className="space-y-1 text-xs">
                  {SECTIONS.map((s) => {
                    const count = Object.keys(pendingImport.sections[s.key] ?? {}).length;
                    if (count === 0) return null;
                    return (
                      <div
                        key={s.key}
                        className="flex justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5"
                      >
                        <span className="text-slate-700 font-medium">{s.label}</span>
                        <span className="font-bold text-slate-900">{count} คำ</span>
                      </div>
                    );
                  })}
                </div>

                <div className="text-[11px] text-slate-500 space-y-1">
                  <p>คำที่มีอยู่แล้วจะถูกทับด้วยค่าจากไฟล์</p>
                  <p>คำที่นำเข้าจะอยู่ในคลังของโปรเจกต์นี้ ไม่กระทบคลังที่ใช้ร่วมกัน</p>
                  {pendingImport.skipped > 0 && (
                    <p className="text-amber-600">
                      ข้าม {pendingImport.skipped} แถวที่มีช่องว่างอยู่ข้างใดข้างหนึ่ง
                    </p>
                  )}
                </div>

                {pendingImport.tooLong.length > 0 && (
                  <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-800">
                      มี {pendingImport.tooLong.length} คำที่ยาวเกิน {MAX_IMPORT_TERM_LENGTH} ตัวอักษร —
                      เก็บได้ครบ แต่ระบบจะตัดให้สั้นลงก่อนส่งให้ AI ทำให้อาจไม่ตรงกับที่พูดจริง
                    </p>
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setPendingImport(null)}
                className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium"
              >
                {pendingImport.status === 'ok' ? 'ยกเลิก' : 'ปิด'}
              </button>
              {pendingImport.status === 'ok' && (
                <button
                  onClick={handleConfirmImport}
                  disabled={disabled}
                  className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 disabled:opacity-40"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>นำเข้า {pendingImport.total} คำ</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {toastMessage && (
        <div className="fixed bottom-4 right-4 z-50 bg-slate-900 text-white text-xs px-3.5 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
