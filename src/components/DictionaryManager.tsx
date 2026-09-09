import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  Code,
  Copy,
  AlertCircle,
  CheckCircle2,
  Search,
  Wand2,
  BookmarkPlus,
  FolderHeart,
  X,
  Layers,
  Table,
  ClipboardPaste,
  Check,
  FileSpreadsheet
} from 'lucide-react';
import { DictionarySet } from '../types';

interface DictionaryManagerProps {
  dictionaryJson?: string;
  onChange: (jsonString: string) => void;
}

interface TermRow {
  id: string;
  term: string;
  equivalent: string;
}

const SAVED_SETS_STORAGE_KEY = 'ai_translate_saved_dict_sets';

export default function DictionaryManager({
  dictionaryJson,
  onChange
}: DictionaryManagerProps) {
  const [activeTab, setActiveTab] = useState<'table' | 'sets' | 'json'>('table');
  const [rows, setRows] = useState<TermRow[]>([]);
  const [jsonText, setJsonText] = useState<string>('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Bottom new row input states
  const [newTerm, setNewTerm] = useState('');
  const [newEquivalent, setNewEquivalent] = useState('');
  const newTermInputRef = useRef<HTMLInputElement>(null);

  // Search & Status
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Excel Paste Modal
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteRawText, setPasteRawText] = useState('');

  // Set management
  const [savedSets, setSavedSets] = useState<DictionarySet[]>([]);
  const [newSetName, setNewSetName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  // Load custom sets from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SAVED_SETS_STORAGE_KEY);
      if (stored) {
        setSavedSets(JSON.parse(stored));
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Sync external JSON string into rows
  useEffect(() => {
    try {
      const parsed = dictionaryJson ? JSON.parse(dictionaryJson) : {};
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const list: TermRow[] = Object.entries(parsed).map(([k, v], index) => ({
          id: `row_${index}_${k}`,
          term: k,
          equivalent: String(v)
        }));
        setRows(list);
        setJsonText(JSON.stringify(parsed, null, 2));
        setJsonError(null);
      }
    } catch {
      setJsonText(dictionaryJson || '{}');
      setJsonError('รูปแบบ JSON ไม่ถูกต้อง');
    }
  }, [dictionaryJson]);

  const commitRows = (updatedRows: TermRow[]) => {
    const obj: Record<string, string> = {};
    for (const item of updatedRows) {
      if (item.term.trim() && item.equivalent.trim()) {
        obj[item.term.trim()] = item.equivalent.trim();
      }
    }
    const formatted = JSON.stringify(obj, null, 2);
    setJsonText(formatted);
    setJsonError(null);
    onChange(formatted);
  };

  // Inline Cell Edit
  const handleCellChange = (id: string, field: 'term' | 'equivalent', value: string) => {
    const updated = rows.map((r) => (r.id === id ? { ...r, [field]: value } : r));
    setRows(updated);
    commitRows(updated);
  };

  // Delete single row
  const handleDeleteRow = (id: string) => {
    const updated = rows.filter((r) => r.id !== id);
    setRows(updated);
    commitRows(updated);
  };

  // Add new row from bottom input
  const handleAddNewRow = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const term = newTerm.trim();
    const equivalent = newEquivalent.trim();
    if (!term && !equivalent) return;

    const newRow: TermRow = {
      id: `row_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      term,
      equivalent
    };

    const updated = [...rows, newRow];
    setRows(updated);
    setNewTerm('');
    setNewEquivalent('');
    commitRows(updated);

    // Keep focus for rapid Excel-like data entry
    setTimeout(() => {
      newTermInputRef.current?.focus();
    }, 50);
  };

  // Parse clipboard text (TSV, CSV, Tab-separated from Excel / Sheets)
  const parseAndAddSpreadsheetData = (text: string) => {
    if (!text.trim()) return 0;
    const lines = text.split(/\r\n|\r|\n/);
    const parsedPairs: Array<{ term: string; equivalent: string }> = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let term = '';
      let equivalent = '';

      if (line.includes('\t')) {
        const parts = line.split('\t');
        term = parts[0]?.trim() || '';
        equivalent = parts.slice(1).join(' ').trim();
      } else if (line.includes(',')) {
        const parts = line.split(',');
        term = parts[0]?.trim() || '';
        equivalent = parts.slice(1).join(',').trim();
      } else if (line.includes('=')) {
        const parts = line.split('=');
        term = parts[0]?.trim() || '';
        equivalent = parts.slice(1).join('=').trim();
      } else if (line.includes(':')) {
        const parts = line.split(':');
        term = parts[0]?.trim().replace(/^["']|["']$/g, '') || '';
        equivalent = parts.slice(1).join(':').trim().replace(/^["']|["']$/g, '');
      } else {
        term = line;
        equivalent = '';
      }

      if (term || equivalent) {
        parsedPairs.push({ term, equivalent });
      }
    }

    if (parsedPairs.length === 0) return 0;

    const existingMap = new Map<string, TermRow>();
    rows.forEach((r) => existingMap.set(r.term.toLowerCase(), r));

    const newRows = [...rows];
    let addedCount = 0;

    for (const pair of parsedPairs) {
      const existing = existingMap.get(pair.term.toLowerCase());
      if (existing) {
        existing.equivalent = pair.equivalent || existing.equivalent;
      } else {
        newRows.push({
          id: `row_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          term: pair.term,
          equivalent: pair.equivalent
        });
        addedCount++;
      }
    }

    setRows(newRows);
    commitRows(newRows);
    return parsedPairs.length;
  };

  const handleTablePaste = (e: React.ClipboardEvent) => {
    const pastedText = e.clipboardData.getData('text');
    if (pastedText && (pastedText.includes('\t') || pastedText.includes('\n'))) {
      e.preventDefault();
      const count = parseAndAddSpreadsheetData(pastedText);
      showToast(`วางข้อมูลสำเร็จ (${count} แถว)`);
    }
  };

  const handleModalPasteSubmit = () => {
    const count = parseAndAddSpreadsheetData(pasteRawText);
    setShowPasteModal(false);
    setPasteRawText('');
    if (count > 0) {
      showToast(`นำเข้าข้อมูลสำเร็จ (${count} รายการ)`);
    }
  };

  const handleCopyTableAsExcel = () => {
    if (rows.length === 0) return;
    const tsv = rows.map((r) => `${r.term}\t${r.equivalent}`).join('\n');
    navigator.clipboard.writeText(tsv);
    setCopied(true);
    showToast('คัดลอกตารางแล้ว');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClearAll = () => {
    if (rows.length === 0) return;
    if (window.confirm('ต้องการล้างคำศัพท์ทั้งหมดในตารางใช่หรือไม่?')) {
      setRows([]);
      commitRows([]);
      showToast('ล้างตารางเรียบร้อยแล้ว');
    }
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        setJsonError(null);
        const list: TermRow[] = Object.entries(parsed).map(([k, v], index) => ({
          id: `row_${index}_${k}`,
          term: k,
          equivalent: String(v)
        }));
        setRows(list);
        onChange(text);
      } else {
        setJsonError('JSON ต้องเป็น Key-Value Object เช่น { "คำต้นทาง": "คำแปล" }');
      }
    } catch (err: any) {
      setJsonError(err.message || 'JSON Syntax Error');
    }
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const beautified = JSON.stringify(parsed, null, 2);
      setJsonText(beautified);
      setJsonError(null);
      onChange(beautified);
      showToast('จัดรูปแบบ JSON เรียบร้อย');
    } catch (err: any) {
      setJsonError(err.message || 'รูปแบบ JSON ไม่ถูกต้อง');
    }
  };

  const handleApplySet = (data: Record<string, string>, name: string) => {
    const list: TermRow[] = Object.entries(data).map(([k, v], index) => ({
      id: `set_item_${index}_${Date.now()}`,
      term: k,
      equivalent: String(v)
    }));
    setRows(list);
    const formatted = JSON.stringify(data, null, 2);
    setJsonText(formatted);
    setJsonError(null);
    onChange(formatted);
    setActiveTab('table');
    showToast(`ใช้งานชุด "${name}" เรียบร้อย`);
  };

  const handleSaveSet = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newSetName.trim();
    if (!name) return;

    let currentObj: Record<string, string> = {};
    for (const item of rows) {
      if (item.term.trim() && item.equivalent.trim()) {
        currentObj[item.term.trim()] = item.equivalent.trim();
      }
    }

    const newSet: DictionarySet = {
      id: `set_${Date.now()}`,
      name,
      data: currentObj,
      createdAt: Date.now()
    };

    const updated = [newSet, ...savedSets];
    setSavedSets(updated);
    try {
      localStorage.setItem(SAVED_SETS_STORAGE_KEY, JSON.stringify(updated));
    } catch (err) {
      console.error(err);
    }

    setNewSetName('');
    setShowSaveDialog(false);
    showToast(`บันทึกชุด "${name}" เรียบร้อยแล้ว`);
  };

  const handleDeleteSavedSet = (id: string, name: string) => {
    if (window.confirm(`ต้องการลบชุดคำศัพท์ "${name}" หรือไม่?`)) {
      const updated = savedSets.filter((s) => s.id !== id);
      setSavedSets(updated);
      try {
        localStorage.setItem(SAVED_SETS_STORAGE_KEY, JSON.stringify(updated));
      } catch (err) {
        console.error(err);
      }
      showToast(`ลบชุด "${name}" แล้ว`);
    }
  };

  const filteredRows = rows.filter(
    (r) =>
      r.term.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.equivalent.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-3 w-full box-border font-sans">
      {/* Toast Feedback */}
      {toastMessage && (
        <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-medium">{toastMessage}</span>
          </div>
          <button onClick={() => setToastMessage(null)} className="text-emerald-500 hover:text-emerald-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Tab Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap border-b border-slate-200 pb-2.5">
        <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('table')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'table'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Table className="w-3.5 h-3.5 text-[#DE5C8E]" />
            <span className="whitespace-nowrap">ตารางคำศัพท์</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === 'table' ? 'bg-[#DE5C8E]/10 text-[#DE5C8E]' : 'bg-slate-200 text-slate-600'
              }`}
            >
              {rows.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('sets')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'sets'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            <span className="whitespace-nowrap">ชุดคำศัพท์</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                activeTab === 'sets' ? 'bg-[#DE5C8E]/10 text-[#DE5C8E]' : 'bg-slate-200 text-slate-600'
              }`}
            >
              {savedSets.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('json')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'json'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span className="whitespace-nowrap">JSON</span>
          </button>
        </div>

        {/* Toolbar actions */}
        {activeTab === 'table' && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowPasteModal(true)}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-1.5 shadow-2xs transition-all whitespace-nowrap"
              title="วางข้อมูลหลายแถวที่คัดลอกจาก Excel หรือ Google Sheets"
            >
              <ClipboardPaste className="w-3.5 h-3.5 text-emerald-600" />
              <span>นำเข้า</span>
            </button>

            {rows.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={handleCopyTableAsExcel}
                  className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-1.5 shadow-2xs transition-all whitespace-nowrap"
                  title="คัดลอกตาราง"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
                  <span>คัดลอก</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowSaveDialog(true)}
                  className="px-2.5 py-1.5 text-xs font-semibold text-[#DE5C8E] bg-[#DE5C8E]/10 hover:bg-[#DE5C8E]/20 border border-[#DE5C8E]/20 rounded-lg flex items-center gap-1.5 transition-all whitespace-nowrap"
                  title="บันทึกตารางนี้เก็บเป็นชุดคำศัพท์"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>บันทึก Set</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Paste Modal */}
      {showPasteModal && (
        <div className="p-3.5 bg-white border border-slate-200 rounded-xl shadow-lg space-y-3 box-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              <span className="text-xs font-bold text-slate-800">วางข้อมูลตารางคำศัพท์</span>
            </div>
            <button
              type="button"
              onClick={() => setShowPasteModal(false)}
              className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            คัดลอกตาราง 2 คอลัมน์ (คอลัมน์ 1: คำต้นทาง, คอลัมน์ 2: คำแปล) แล้ววางลงในกล่องข้อความด้านล่าง:
          </p>

          <textarea
            value={pasteRawText}
            onChange={(e) => setPasteRawText(e.target.value)}
            rows={5}
            placeholder={`ปัญญาประดิษฐ์\tArtificial Intelligence\nการเรียนรู้ของเครื่อง\tMachine Learning\nKPI\tKey Performance Indicator`}
            className="w-full p-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] box-border leading-relaxed"
            autoFocus
          />

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowPasteModal(false)}
              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleModalPasteSubmit}
              disabled={!pasteRawText.trim()}
              className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-2xs disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>นำเข้าข้อมูล</span>
            </button>
          </div>
        </div>
      )}

      {/* Save Set Form Dialog */}
      {showSaveDialog && (
        <form
          onSubmit={handleSaveSet}
          className="p-3.5 bg-white border border-slate-200 rounded-xl shadow-lg space-y-3 box-border"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center gap-2">
              <FolderHeart className="w-4 h-4 text-[#DE5C8E]" />
              <span>บันทึกชุดคำศัพท์ ({rows.length} รายการ)</span>
            </span>
            <button
              type="button"
              onClick={() => setShowSaveDialog(false)}
              className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div>
            <input
              type="text"
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              placeholder="ระบุชื่อชุดคำศัพท์ (เช่น ประชุมวิชาการ, ศัพท์เทคนิคการแพทย์)"
              className="w-full box-border px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E]"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowSaveDialog(false)}
              className="px-3 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={!newSetName.trim()}
              className="px-3.5 py-1.5 text-xs text-white bg-[#DE5C8E] hover:bg-[#c94577] rounded-lg font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              <span>บันทึก</span>
            </button>
          </div>
        </form>
      )}

      {/* TAB 1: SPREADSHEET TABLE */}
      {activeTab === 'table' && (
        <div className="space-y-2.5">
          {/* Search Bar */}
          {rows.length > 4 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ค้นหาคำศัพท์ในตาราง..."
                className="w-full box-border pl-8.5 pr-8 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-slate-400"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Table Container */}
          <div
            className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs"
            onPaste={handleTablePaste}
          >
            <div className="max-h-72 overflow-y-auto overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse table-fixed">
                <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200 sticky top-0 z-10 select-none">
                  <tr>
                    <th className="w-10 py-2 px-2.5 text-center text-[11px] text-slate-400 border-r border-slate-200">#</th>
                    <th className="w-[45%] py-2 px-3 border-r border-slate-200 text-slate-700">คำต้นทาง</th>
                    <th className="w-[45%] py-2 px-3 text-[#DE5C8E]">คำแปลที่กำหนด</th>
                    <th className="w-10 py-2 px-1 text-center"></th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100">
                  {filteredRows.length === 0 && rows.length > 0 && searchQuery ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-400 text-xs">
                        ไม่พบคำศัพท์ที่ตรงกับคำค้นหา
                      </td>
                    </tr>
                  ) : null}

                  {filteredRows.map((row, index) => (
                    <tr key={row.id} className="hover:bg-slate-50/80 group transition-colors">
                      <td className="py-1 px-2 text-center text-[11px] text-slate-400 bg-slate-50/30 border-r border-slate-200 font-mono select-none">
                        {index + 1}
                      </td>

                      <td className="py-0.5 px-1.5 border-r border-slate-200">
                        <input
                          type="text"
                          value={row.term}
                          onChange={(e) => handleCellChange(row.id, 'term', e.target.value)}
                          placeholder="คำต้นทาง"
                          className="w-full px-2 py-1.5 text-xs text-slate-900 bg-transparent hover:bg-slate-100/70 focus:bg-white focus:ring-1 focus:ring-[#DE5C8E] rounded-md outline-none font-medium truncate"
                        />
                      </td>

                      <td className="py-0.5 px-1.5">
                        <input
                          type="text"
                          value={row.equivalent}
                          onChange={(e) => handleCellChange(row.id, 'equivalent', e.target.value)}
                          placeholder="คำแปล"
                          className="w-full px-2 py-1.5 text-xs text-[#DE5C8E] bg-transparent hover:bg-slate-100/70 focus:bg-white focus:ring-1 focus:ring-[#DE5C8E] rounded-md outline-none font-semibold truncate"
                        />
                      </td>

                      <td className="py-0.5 px-1 text-center">
                        <button
                          type="button"
                          onClick={() => handleDeleteRow(row.id)}
                          className="p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded transition-all"
                          title="ลบแถวนี้"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}

                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400 text-xs">
                        <div className="space-y-1">
                          <p className="font-semibold text-slate-700">ยังไม่มีรายการคำศัพท์เฉพาะทาง</p>
                          <p className="text-xs text-slate-400">
                            พิมพ์ข้อมูลด้านล่าง หรือกด <strong>&quot;นำเข้า&quot;</strong> เพื่อวางจากไฟล์ข้อมูล
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Inline Add Row Footer */}
            <form
              onSubmit={handleAddNewRow}
              className="bg-slate-50 border-t border-slate-200 p-2 flex items-center gap-1.5 text-xs"
            >
              <div className="w-7 text-center text-slate-400 font-mono text-xs select-none shrink-0">
                +
              </div>
              <input
                ref={newTermInputRef}
                type="text"
                value={newTerm}
                onChange={(e) => setNewTerm(e.target.value)}
                placeholder="คำต้นทาง..."
                className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] placeholder:text-slate-400"
              />
              <input
                type="text"
                value={newEquivalent}
                onChange={(e) => setNewEquivalent(e.target.value)}
                placeholder="คำแปลที่กำหนด..."
                className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] placeholder:text-slate-400"
              />
              <button
                type="submit"
                disabled={!newTerm.trim() && !newEquivalent.trim()}
                className="px-3 py-1.5 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-40 shrink-0 shadow-2xs whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>เพิ่ม</span>
              </button>
            </form>
          </div>

          {/* Quick Info & Clear helper */}
          <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
            <span>
              แก้ไขข้อความในตารางได้โดยตรง หรือกดคีย์ลัดวางข้อมูลลงตาราง
            </span>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                className="text-slate-400 hover:text-rose-600 transition-colors shrink-0 ml-2 font-medium"
              >
                ล้างทั้งหมด
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: SAVED SETS */}
      {activeTab === 'sets' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <FolderHeart className="w-4 h-4 text-[#DE5C8E]" />
              <span>ชุดคำศัพท์ที่บันทึก ({savedSets.length})</span>
            </span>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSaveDialog(true)}
                className="text-[#DE5C8E] hover:underline font-semibold text-xs flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> <span>บันทึกชุดปัจจุบัน</span>
              </button>
            )}
          </div>

          {savedSets.length === 0 ? (
            <div className="p-8 bg-slate-50 border border-dashed border-slate-200 rounded-xl text-center space-y-1.5">
              <FolderHeart className="w-7 h-7 text-slate-300 mx-auto" />
              <div className="text-xs text-slate-700 font-semibold">ยังไม่มีชุดคำศัพท์ที่บันทึกไว้</div>
              <p className="text-xs text-slate-400 max-w-xs mx-auto">
                เพิ่มคำศัพท์ในตาราง แล้วกด <strong>&quot;บันทึก Set&quot;</strong> เพื่อเก็บไว้สลับใช้งาน
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 max-h-72 overflow-y-auto pr-0.5">
              {savedSets.map((set) => {
                const count = Object.keys(set.data || {}).length;
                return (
                  <div
                    key={set.id}
                    className="p-3 bg-white border border-slate-200 hover:border-slate-300 rounded-xl flex items-center justify-between gap-3 shadow-2xs transition-all"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-xs text-slate-800 truncate">
                        {set.name}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5 font-medium">
                        <span className="text-[#DE5C8E]">{count} คำศัพท์</span>
                        <span>•</span>
                        <span>{new Date(set.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleApplySet(set.data, set.name)}
                        className="px-3 py-1.5 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition-all"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>ใช้งาน</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSavedSet(set.id, set.name)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-all"
                        title="ลบชุดนี้"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: JSON */}
      {activeTab === 'json' && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400 font-mono text-[11px]">{`{ "คำต้นทาง": "คำแปล" }`}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleFormatJson}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all"
              >
                <Wand2 className="w-3.5 h-3.5 text-[#DE5C8E]" />
                <span>จัดรูปแบบ</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(jsonText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</span>
              </button>
            </div>
          </div>

          <textarea
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            rows={8}
            spellCheck={false}
            className={`w-full p-3 font-mono text-xs bg-slate-900 text-slate-100 rounded-xl outline-none leading-relaxed box-border ${
              jsonError ? 'border border-rose-500' : 'border border-slate-700 focus:border-[#DE5C8E]'
            }`}
          />

          {jsonError && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{jsonError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
