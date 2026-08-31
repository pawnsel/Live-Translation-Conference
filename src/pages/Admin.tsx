import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Mic,
  MicOff,
  Languages,
  BookOpen,
  Key,
  Copy,
  Check,
  Download,
  Trash2,
  Sparkles,
  Zap,
  Activity,
  Edit2,
  X,
  RotateCcw,
  Sliders,
  Radio,
  Eye,
  EyeOff,
  Menu,
  ShieldCheck,
  Lock,
  ShieldAlert,
  Cpu,
  Volume2,
  FileText,
  ArrowLeftRight,
  Send,
  Scissors,
  Timer
} from 'lucide-react';
import { AppConfig, TranscriptItem } from '../types';
import DictionaryManager from '../components/DictionaryManager';

export default function Admin() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [config, setConfig] = useState<AppConfig>({
    sourceLang: 'th-TH',
    targetLang: 'English',
    aiModel: 'gemini-3.7-flash',
    speechEngine: 'google-chirp-asr',
    fontSize: 'large',
    fontFamily: 'sans-serif',
    dictionaryJson: JSON.stringify(
      {
        ปัญญาประดิษฐ์: 'Artificial Intelligence (AI)',
        การเรียนรู้ของเครื่อง: 'Machine Learning',
        โมเดลภาษาขนาดใหญ่: 'Large Language Models (LLMs)',
        การประชุมประจำปี: 'Annual General Meeting (AGM)',
        ผลตอบแทนจากการลงทุน: 'Return on Investment (ROI)',
        ตัวชี้วัดความสำเร็จ: 'KPI / Key Performance Indicators'
      },
      null,
      2
    ),
    showOriginal: true,
    showLatency: true,
    hasCustomToken: false,
    chunkSilenceMs: 900
  });

  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary' | 'token'>('languages');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);

  // Manual / Quick Test Input
  const [testInputText, setTestInputText] = useState('');

  // Latency & Connection Metrics
  const [socketPingMs, setSocketPingMs] = useState<number | null>(null);
  const [lastAiLatencyMs, setLastAiLatencyMs] = useState<number | null>(null);

  // Token management & Secret Key protection
  const [inputToken, setInputToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [testingToken, setTestingToken] = useState(false);
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [tokenSavedSuccess, setTokenSavedSuccess] = useState(false);
  const [tokenTestResult, setTokenTestResult] = useState<{ success?: boolean; message?: string } | null>(null);

  // Editing items
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTranslatedText, setEditTranslatedText] = useState<string>('');
  const [editOriginalText, setEditOriginalText] = useState<string>('');
  const [savedFeedbackId, setSavedFeedbackId] = useState<string | null>(null);

  // Copy feedback
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);

  // Speech Recognition & Realtime Chunking Refs
  const recognitionRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
  const configRef = useRef<AppConfig>(config);
  const isMeetingActiveRef = useRef<boolean>(false);
  const isListeningRef = useRef<boolean>(false);
  const silenceTimerRef = useRef<any>(null);
  const currentInterimRef = useRef<string>('');
  const isRestartingRef = useRef<boolean>(false);

  const [isListening, setIsListening] = useState(false);
  const [interimSpeechText, setInterimSpeechText] = useState('');
  const [micPermissionError, setMicPermissionError] = useState(false);
  const [micAudioLevel, setMicAudioLevel] = useState<number>(0);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // Keep fresh state in refs for async callbacks & speech recognition
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    isMeetingActiveRef.current = isMeetingActive;
  }, [isMeetingActive]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  // Commit recognized speech segment/chunk for live translation
  const commitSpeechChunk = (text: string) => {
    const cleanText = text.trim();
    if (!cleanText || cleanText.length < 2) return;

    if (socketRef.current) {
      socketRef.current.emit('new-transcription', cleanText);
    }

    currentInterimRef.current = '';
    setInterimSpeechText('');

    // Cleanly flush the browser's speech recognition buffer to prevent repeat words
    if (isListeningRef.current && recognitionRef.current) {
      try {
        isRestartingRef.current = true;
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }
  };

  const handleForceCommitInterim = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    const textToCommit = (currentInterimRef.current || interimSpeechText).trim();
    if (textToCommit) {
      commitSpeechChunk(textToCommit);
    }
  };

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('config-updated', (newConfig: AppConfig) => {
      setConfig((prev) => ({ ...prev, ...newConfig }));
    });

    newSocket.on('transcripts-updated', (items: TranscriptItem[]) => {
      setTranscripts(items);
      // Track last translation latency
      const latestWithLatency = [...items].reverse().find((t) => t.latencyMs !== undefined);
      if (latestWithLatency && latestWithLatency.latencyMs) {
        setLastAiLatencyMs(latestWithLatency.latencyMs);
      }

      // Auto scroll down smoothly
      setTimeout(() => {
        if (transcriptScrollRef.current && !editingItemId) {
          transcriptScrollRef.current.scrollTo({
            top: transcriptScrollRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      }, 80);
    });

    newSocket.on('meeting-status', (status: boolean) => {
      setIsMeetingActive(status);
      if (status) {
        startListening();
      } else {
        stopListening();
      }
    });

    newSocket.on('test-token-result', (result: { success: boolean; message: string }) => {
      setTestingToken(false);
      setTokenTestResult(result);
      setTimeout(() => setTokenTestResult(null), 4000);
    });

    // Pong for live socket ping calculation
    newSocket.on('pong-check', (data: { clientTimestamp: number }) => {
      const ping = Date.now() - data.clientTimestamp;
      setSocketPingMs(ping);
    });

    // Start periodic heartbeat ping
    const pingInterval = setInterval(() => {
      if (newSocket.connected) {
        newSocket.emit('ping-check', Date.now());
      }
    }, 3000);

    return () => {
      clearInterval(pingInterval);
      newSocket.close();
      stopListening();
    };
  }, [editingItemId]);

  // Handle Speech Recognition setup with smart pause segmentation / chunking
  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('เบราว์เซอร์นี้ไม่รองรับ Web Speech API กรุณาเปิดด้วย Google Chrome หรือ Microsoft Edge');
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = configRef.current.sourceLang || 'th-TH';

    recognition.onstart = () => {
      setIsListening(true);
      isListeningRef.current = true;
      setMicPermissionError(false);
      setMicAudioLevel(35);
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        setMicPermissionError(true);
      }
      if (event.error !== 'no-speech') {
        setIsListening(false);
        isListeningRef.current = false;
      }
    };

    recognition.onend = () => {
      setMicAudioLevel(0);
      // Auto reconnect if meeting is active or restarting after a segment chunk commit
      if (isMeetingActiveRef.current || isRestartingRef.current) {
        isRestartingRef.current = false;
        try {
          recognition.start();
          setIsListening(true);
          isListeningRef.current = true;
        } catch {
          // ignore
        }
      } else {
        setIsListening(false);
        isListeningRef.current = false;
        setInterimSpeechText('');
      }
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalChunk += transcript + ' ';
        } else {
          interim += transcript;
        }
      }

      // 1. If ASR emitted a final segment, commit it immediately
      if (finalChunk.trim()) {
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        commitSpeechChunk(finalChunk);
        return;
      }

      // 2. If interim results are arriving:
      const trimmedInterim = interim.trim();
      if (trimmedInterim) {
        currentInterimRef.current = trimmedInterim;
        setInterimSpeechText(trimmedInterim);
        setMicAudioLevel(Math.min(95, 30 + Math.random() * 50));

        // Reset silence timer on every new speech acoustic packet
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
        }

        // Get configured silence threshold (default 900ms)
        const silenceThreshold = configRef.current.chunkSilenceMs || 900;

        // Auto-commit chunk when speaker pauses for silenceThreshold ms
        silenceTimerRef.current = setTimeout(() => {
          if (currentInterimRef.current.trim()) {
            commitSpeechChunk(currentInterimRef.current);
          }
        }, silenceThreshold);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
      isListeningRef.current = true;
    } catch (e) {
      console.error(e);
    }
  };

  const stopListening = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    currentInterimRef.current = '';
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
    isListeningRef.current = false;
    setMicAudioLevel(0);
    setInterimSpeechText('');
  };

  const toggleMeeting = () => {
    if (!socket) return;
    if (isMeetingActive) {
      socket.emit('stop-meeting');
    } else {
      socket.emit('start-meeting');
    }
  };

  const handleConfigChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    let newConfig = {
      ...config,
      [name]: type === 'checkbox' ? checked : value
    };

    // Auto-switch complementary language (Thai <-> English)
    if (name === 'sourceLang') {
      if (value === 'th-TH') {
        newConfig.targetLang = 'English';
      } else if (value === 'en-US') {
        newConfig.targetLang = 'Thai';
      }
    } else if (name === 'targetLang') {
      if (value === 'English') {
        newConfig.sourceLang = 'th-TH';
      } else if (value === 'Thai') {
        newConfig.sourceLang = 'en-US';
      }
    }

    setConfig(newConfig);
    if (socket) {
      socket.emit('update-config', newConfig);
    }

    // If source language changed while listening, restart recognition
    if (name === 'sourceLang' && isMeetingActive) {
      stopListening();
      setTimeout(() => startListening(), 250);
    }
  };

  const handleSwapLanguages = () => {
    const newSource = config.sourceLang === 'th-TH' ? 'en-US' : 'th-TH';
    const newTarget = newSource === 'th-TH' ? 'English' : 'Thai';
    const newConfig = {
      ...config,
      sourceLang: newSource,
      targetLang: newTarget
    };
    setConfig(newConfig);
    if (socket) {
      socket.emit('update-config', newConfig);
    }
    if (isMeetingActive) {
      stopListening();
      setTimeout(() => startListening(), 250);
    }
  };

  const handleSendTestText = (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : testInputText).trim();
    if (!text || !socket) return;
    socket.emit('new-transcription', text);
    if (overrideText === undefined) {
      setTestInputText('');
    }
  };

  const handleSaveToken = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputToken.trim() || !socket) return;
    setIsSavingToken(true);
    socket.emit('update-config', { apiToken: inputToken.trim() });
    setInputToken('');
    setTokenSavedSuccess(true);
    setTimeout(() => {
      setIsSavingToken(false);
      setTokenSavedSuccess(false);
    }, 2500);
  };

  const handleDeleteToken = () => {
    if (!socket) return;
    if (window.confirm('ยืนยันลบ Custom API Key ออกจาก Server และกลับไปใช้ Default Gemini Key?')) {
      socket.emit('update-config', { clearToken: true });
    }
  };

  const handleTestToken = (customCandidate?: string) => {
    if (!socket) return;
    setTestingToken(true);
    setTokenTestResult(null);
    socket.emit('test-token', customCandidate || '');
  };

  const handleCopyItem = (item: TranscriptItem) => {
    const fullText = `${item.originalText}\n${item.translatedText}`;
    navigator.clipboard.writeText(fullText);
    setCopiedItemId(item.id);
    setTimeout(() => setCopiedItemId(null), 1500);
  };

  const startEditing = (item: TranscriptItem) => {
    setEditingItemId(item.id);
    setEditTranslatedText(item.translatedText);
    setEditOriginalText(item.originalText);
  };

  const cancelEditing = () => {
    setEditingItemId(null);
    setEditTranslatedText('');
    setEditOriginalText('');
  };

  const saveCorrection = (id: string) => {
    if (!socket) return;
    socket.emit('update-transcript-item', {
      id,
      translatedText: editTranslatedText.trim(),
      originalText: editOriginalText.trim()
    });
    setSavedFeedbackId(id);
    setTimeout(() => setSavedFeedbackId(null), 2000);
    setEditingItemId(null);
  };

  const deleteItem = (id: string) => {
    if (socket) {
      socket.emit('delete-transcript-item', id);
    }
  };

  const retranslateItem = (item: TranscriptItem) => {
    if (!socket) return;
    socket.emit('retranslate-item', {
      id: item.id,
      text: editOriginalText || item.originalText
    });
    setEditingItemId(null);
  };

  const clearTranscripts = () => {
    if (socket && window.confirm('ล้างประวัติการแปลทั้งหมด?')) {
      socket.emit('clear-transcripts');
    }
  };

  const exportTranscript = (type: 'txt' | 'srt') => {
    if (transcripts.length === 0) return;
    let content = '';
    const dateStr = new Date().toISOString().slice(0, 10);

    if (type === 'txt') {
      content = `=== Live Translation Transcript (${dateStr}) ===\n${config.sourceLang} -> ${config.targetLang}\n\n`;
      content += transcripts
        .map(
          (t, i) =>
            `[${i + 1}] ${new Date(t.timestamp).toLocaleTimeString()}${t.isEdited ? ' (edited)' : ''} [${t.latencyMs || '-'}ms]\nOriginal: ${t.originalText}\nTranslated: ${t.translatedText}\n`
        )
        .join('\n');
    } else {
      const formatSrtTime = (ms: number) => {
        const d = new Date(ms);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        const msStr = String(d.getUTCMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss},${msStr}`;
      };

      const startBase = transcripts[0].timestamp;
      content = transcripts
        .map((t, idx) => {
          const startTime = Math.max(0, t.timestamp - startBase);
          const endTime = startTime + 3500;
          return `${idx + 1}\n${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n${t.translatedText}\n`;
        })
        .join('\n');
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${dateStr}.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Font size styling helper
  const getTextSizeClass = () => {
    switch (config.fontSize) {
      case 'small':
        return 'text-sm sm:text-base';
      case 'medium':
        return 'text-base sm:text-lg';
      case 'xlarge':
        return 'text-xl sm:text-2xl';
      case 'large':
      default:
        return 'text-lg sm:text-xl';
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-slate-100 text-slate-800 font-sans overflow-hidden">
      {/* ─────────────────────────────────────────────────────────────
          TOP CONTROL & METRICS BAR (Professional Minimal Header)
      ────────────────────────────────────────────────────────────── */}
      <header className="h-15 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between shrink-0 z-30 shadow-xs">
        {/* Brand & Mobile Sidebar Toggle */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setMobileSettingsOpen(!mobileSettingsOpen)}
            className="lg:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
            title="เปิดเมนูตั้งค่า"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5">
            <div className="w-8.5 h-8.5 rounded-lg bg-[#DE5C8E] flex items-center justify-center text-white shadow-xs">
              <Sparkles className="w-4.5 h-4.5" />
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-sm text-slate-900 tracking-tight leading-none">
                AI Live Translator
              </span>
              <span className="text-[11px] text-slate-400 font-medium leading-tight mt-0.5">
                Google Chirp + Gemini 3.7
              </span>
            </div>
          </div>
        </div>

        {/* Status Indicators & Main Action Button */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Live Status Badge */}
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
              isMeetingActive
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 ring-2 ring-emerald-100'
                : 'bg-slate-100 text-slate-500 border border-slate-200'
            }`}
          >
            {isMeetingActive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="tracking-wider text-[11px] font-bold uppercase whitespace-nowrap">
                  กำลังแปลสด
                </span>
                {/* Visualizer bars */}
                <div className="hidden sm:flex items-center gap-0.5 ml-1 h-3.5 bg-emerald-200/70 px-1 rounded">
                  <div
                    className="w-1 bg-emerald-600 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(25, micAudioLevel)}%` }}
                  />
                  <div
                    className="w-1 bg-emerald-600 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(15, micAudioLevel * 0.7)}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                <span className="text-[11px] whitespace-nowrap">พร้อมใช้งาน</span>
              </>
            )}
          </div>

          {/* Real-time Telemetry (AI Latency & Ping) */}
          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full text-[11px] font-mono border border-slate-200">
            <Zap className={`w-3.5 h-3.5 ${isMeetingActive ? 'text-amber-500' : 'text-slate-400'}`} />
            <span className="text-slate-500">AI:</span>
            <span className="font-semibold text-slate-800">
              {lastAiLatencyMs ? `${lastAiLatencyMs}ms` : '--'}
            </span>
            <span className="text-slate-300">|</span>
            <Activity className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-slate-500">Ping:</span>
            <span className="font-semibold text-slate-800">
              {socketPingMs !== null ? `${socketPingMs}ms` : '--'}
            </span>
          </div>

          {/* Start / Stop Primary Button */}
          <button
            onClick={toggleMeeting}
            className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-xs whitespace-nowrap ${
              isMeetingActive
                ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse'
                : 'bg-[#DE5C8E] hover:bg-[#c94577] text-white'
            }`}
          >
            {isMeetingActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{isMeetingActive ? 'หยุดแปลสด' : 'เริ่มแปลสด'}</span>
          </button>
        </div>
      </header>

      {/* ─────────────────────────────────────────────────────────────
          MAIN WORKSPACE LAYOUT
      ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* LEFT SETTINGS SIDEBAR */}
        <aside
          className={`fixed inset-y-15 left-0 z-20 w-84 lg:w-96 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
            mobileSettingsOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
          }`}
        >
          {/* Navigation Tabs */}
          <div className="grid grid-cols-3 p-1.5 bg-slate-50 border-b border-slate-200 text-xs gap-1 shrink-0">
            <button
              onClick={() => setActiveTab('languages')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'languages'
                  ? 'bg-white text-[#DE5C8E] shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Languages className="w-4 h-4" />
              <span className="whitespace-nowrap">ภาษาและ AI</span>
            </button>
            <button
              onClick={() => setActiveTab('dictionary')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'dictionary'
                  ? 'bg-white text-[#DE5C8E] shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span className="whitespace-nowrap">พจนานุกรม</span>
            </button>
            <button
              onClick={() => setActiveTab('token')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all relative ${
                activeTab === 'token'
                  ? 'bg-white text-[#DE5C8E] shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Key className="w-4 h-4" />
              <span className="whitespace-nowrap">API Key</span>
              {config.hasCustomToken && (
                <span className="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white absolute top-1.5 right-2"></span>
              )}
            </button>
          </div>

          {/* Sidebar Tab Content */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {/* TAB 1: LANGUAGES & AI ENGINE */}
            {activeTab === 'languages' && (
              <div className="space-y-4">
                {/* Speech Recognition Engine (Chirp 3 / Cloud ASR) */}
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-[#DE5C8E]" />
                      <span>ระบบแปลงเสียงพูด (Speech ASR)</span>
                    </span>
                    <span className="text-[10px] bg-emerald-50 text-emerald-800 font-semibold px-2 py-0.5 rounded-md border border-emerald-200">
                      Chirp 3 Engine
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    เอนจิน Google Cloud Speech &amp; Chirp แปลงเสียงสดเป็นข้อความอัตโนมัติความเร็วสูง (&lt;100ms)
                  </p>
                </div>

                {/* AI Model Selection */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-slate-700">
                      โมเดล AI แปลภาษา (Translation Model)
                    </label>
                    <span className="text-[10px] text-purple-700 font-mono font-semibold">Gemini API</span>
                  </div>
                  <select
                    name="aiModel"
                    value={config.aiModel || 'gemini-3.7-flash'}
                    onChange={handleConfigChange}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium"
                  >
                    <option value="gemini-3.7-flash">Gemini 3.7 Flash (แนะนำ: ความเร็วสูง ตอบสนองทันที)</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash (มาตรฐานความเร็วสูง)</option>
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro (แม่นยำสูง สำหรับเนื้อหาเชิงวิชาการ)</option>
                  </select>
                </div>

                {/* Source & Target Language (Thai <-> English) */}
                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">คู่ภาษาแปลสด (Thai ↔ English)</span>
                    <button
                      type="button"
                      onClick={handleSwapLanguages}
                      className="text-[11px] px-2.5 py-1 bg-white hover:bg-pink-50 text-[#DE5C8E] border border-pink-200 rounded-lg font-bold flex items-center gap-1 shadow-2xs transition-all cursor-pointer"
                      title="สลับภาษาผู้พูดและภาษาแปล"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5" />
                      <span>สลับภาษา</span>
                    </button>
                  </div>

                  {/* Source Language */}
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      ภาษาของผู้พูด (Source Language)
                    </label>
                    <select
                      name="sourceLang"
                      value={config.sourceLang}
                      onChange={handleConfigChange}
                      disabled={isMeetingActive}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] disabled:opacity-60 font-semibold text-slate-800"
                    >
                      <option value="th-TH">ไทย (Thai - th-TH)</option>
                      <option value="en-US">อังกฤษ (English - en-US)</option>
                    </select>
                  </div>

                  {/* Target Language */}
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      ภาษาที่ต้องการแปล (Target Language - อัตโนมัติ)
                    </label>
                    <select
                      name="targetLang"
                      value={config.targetLang}
                      onChange={handleConfigChange}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] font-semibold text-[#DE5C8E]"
                    >
                      <option value="English">แปลเป็นอังกฤษ (English)</option>
                      <option value="Thai">แปลเป็นไทย (Thai)</option>
                    </select>
                  </div>
                </div>

                {/* Chunking / Silence Pause Segmentation */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-slate-700">
                      ความไวการตัดช่วงแปลสด (Live Chunking)
                    </label>
                    <span className="text-[10px] text-[#DE5C8E] font-semibold flex items-center gap-1">
                      <Timer className="w-3 h-3" />
                      <span>{config.chunkSilenceMs || 900}ms</span>
                    </span>
                  </div>
                  <select
                    name="chunkSilenceMs"
                    value={config.chunkSilenceMs || 900}
                    onChange={handleConfigChange}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium"
                  >
                    <option value={600}>⚡ เร็วมาก (Fast: ~0.6 วินาที - แปลสดคำต่อคำ)</option>
                    <option value={900}>⚖️ มาตรฐาน (Balanced: ~0.9 วินาที - แนะนำ จังหวะหายใจ)</option>
                    <option value={1400}>🧘 ผ่อนคลาย (Relaxed: ~1.4 วินาที - รอจบประโยคยาว)</option>
                  </select>
                  <p className="mt-1 text-[11px] text-slate-500 leading-normal">
                    ระบบจะตัดวรรคส่งให้ AI แปลทันทีแบบเรียลไทม์เมื่อตรวจพบการหยุดพูดตามเวลาที่กำหนด
                  </p>
                </div>

                {/* Font Size Option */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    ขนาดตัวอักษรข้อความแปล (Font Size)
                  </label>
                  <select
                    name="fontSize"
                    value={config.fontSize || 'large'}
                    onChange={handleConfigChange}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium"
                  >
                    <option value="small">ขนาดเล็ก (Small)</option>
                    <option value="medium">ขนาดปานกลาง (Medium)</option>
                    <option value="large">ขนาดใหญ่ (Large - แนะนำ)</option>
                    <option value="xlarge">ขนาดใหญ่พิเศษ (Extra Large)</option>
                  </select>
                </div>

                {/* Options checklist */}
                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      name="showOriginal"
                      checked={config.showOriginal !== false}
                      onChange={handleConfigChange}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงประโยคต้นฉบับคู่กับคำแปล</span>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      name="showLatency"
                      checked={config.showLatency !== false}
                      onChange={handleConfigChange}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงความเร็วการตอบสนอง (Latency ms)</span>
                  </label>
                </div>
              </div>
            )}

            {/* TAB 2: DICTIONARY */}
            {activeTab === 'dictionary' && (
              <div>
                <DictionaryManager
                  dictionaryJson={config.dictionaryJson}
                  onChange={(newJson) => {
                    const updated = { ...config, dictionaryJson: newJson };
                    setConfig(updated);
                    if (socket) socket.emit('update-config', updated);
                  }}
                />
              </div>
            )}

            {/* TAB 3: API KEY / TOKEN */}
            {activeTab === 'token' && (
              <div className="space-y-4">
                {/* Security Status Banner */}
                {config.hasCustomToken ? (
                  <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-emerald-800 font-semibold text-xs">
                        <ShieldCheck className="w-4.5 h-4.5 text-emerald-600 shrink-0" />
                        <span>บันทึก Key บน Server ปลอดภัย</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleDeleteToken}
                        className="p-1.5 text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-all"
                        title="ลบ Key ออกจาก Server และกลับไปใช้ Default Key"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleTestToken()}
                      disabled={testingToken}
                      className="w-full py-2 bg-white border border-emerald-300 hover:bg-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold transition-all shadow-xs disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-600" />
                      <span>{testingToken ? 'กำลังตรวจสอบ...' : 'ทดสอบการเชื่อมต่อ API Key'}</span>
                    </button>
                  </div>
                ) : (
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                    <div className="flex items-center gap-2 text-slate-700 font-semibold text-xs">
                      <Lock className="w-4 h-4 text-slate-500 shrink-0" />
                      <span>กำลังใช้ Default API Key ของระบบ</span>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      คุณสามารถระบุ Gemini API Key ส่วนตัวเพื่อขยายขีดจำกัดโควต้าและความเร็วในการประมวลผลได้
                    </p>
                  </div>
                )}

                {/* Input New Key Form */}
                <form onSubmit={handleSaveToken} className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-[#DE5C8E]" />
                      <span>{config.hasCustomToken ? 'เปลี่ยน API Key ใหม่' : 'ระบุ Gemini API Key ส่วนตัว'}</span>
                    </label>
                    {inputToken && (
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
                      >
                        {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{showToken ? 'ซ่อน' : 'แสดง'}</span>
                      </button>
                    )}
                  </div>

                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={inputToken}
                      onChange={(e) => setInputToken(e.target.value)}
                      placeholder="วาง Gemini API Key (เช่น AIzaSy...)"
                      className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono outline-none focus:bg-white focus:border-[#DE5C8E] transition-all pr-8"
                    />
                    {inputToken && (
                      <button
                        type="button"
                        onClick={() => setInputToken('')}
                        className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={!inputToken.trim() || isSavingToken}
                      className="flex-1 py-2 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-bold transition-all shadow-xs disabled:opacity-40 flex items-center justify-center gap-1.5"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>{isSavingToken ? 'กำลังบันทึก...' : 'บันทึก Key ลง Server'}</span>
                    </button>
                    {inputToken.trim() && (
                      <button
                        type="button"
                        onClick={() => handleTestToken(inputToken.trim())}
                        disabled={testingToken}
                        className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition-all disabled:opacity-50 whitespace-nowrap"
                      >
                        ทดสอบ Key
                      </button>
                    )}
                  </div>
                </form>

                {/* Save Feedback */}
                {tokenSavedSuccess && (
                  <div className="p-3 rounded-xl text-xs bg-emerald-50 border border-emerald-300 text-emerald-800 flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>บันทึก API Key บน Server สำเร็จและซ่อนจากฝั่ง Client แล้ว</span>
                  </div>
                )}

                {/* Test Result Feedback */}
                {tokenTestResult && (
                  <div
                    className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                      tokenTestResult.success
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : 'bg-rose-50 text-rose-800 border-rose-200'
                    }`}
                  >
                    {tokenTestResult.success ? (
                      <ShieldCheck className="w-4.5 h-4.5 text-emerald-600 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4.5 h-4.5 text-rose-600 shrink-0" />
                    )}
                    <span>{tokenTestResult.message}</span>
                  </div>
                )}

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500 space-y-1.5">
                  <div className="font-semibold text-slate-700 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />
                    <span>ระบบรักษาความปลอดภัย:</span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-500">
                    <li>API Key ได้รับการเข้ารหัสและจัดเก็บบน Server-Side เท่านั้น</li>
                    <li>ไม่เปิดเผย API Key ผ่านทาง Network Request หรือ DevTools</li>
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Close drawer button on mobile */}
          <div className="p-3 border-t border-slate-200 lg:hidden">
            <button
              onClick={() => setMobileSettingsOpen(false)}
              className="w-full py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg"
            >
              ปิดหน้าต่างตั้งค่า
            </button>
          </div>
        </aside>

        {/* Backdrop for mobile drawer */}
        {mobileSettingsOpen && (
          <div
            onClick={() => setMobileSettingsOpen(false)}
            className="fixed inset-0 bg-black/30 z-10 lg:hidden"
          />
        )}

        {/* ─────────────────────────────────────────────────────────────
            MAIN TRANSLATION FEED & ACTIVE TRANSCRIPT MONITOR
        ────────────────────────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col bg-slate-50 min-w-0">
          {/* Feed Header */}
          <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Radio className={`w-4 h-4 ${isListening ? 'text-emerald-500 animate-pulse' : 'text-slate-400'}`} />
              <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                <span className="font-bold text-slate-800">
                  {config.sourceLang === 'th-TH' ? 'ไทย (TH)' : 'อังกฤษ (EN)'} ➔ {config.targetLang}
                </span>
                <button
                  onClick={handleSwapLanguages}
                  className="p-1 hover:bg-white rounded-md text-slate-500 hover:text-[#DE5C8E] transition-all cursor-pointer"
                  title="สลับภาษาผู้พูดและภาษาแปล"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className="text-slate-400 font-medium hidden sm:inline">({transcripts.length} รายการ)</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => exportTranscript('txt')}
                disabled={transcripts.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกข้อความ TXT"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>TXT</span>
              </button>

              <button
                onClick={() => exportTranscript('srt')}
                disabled={transcripts.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกคำบรรยาย SRT"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                <span>SRT</span>
              </button>

              <button
                onClick={clearTranscripts}
                disabled={transcripts.length === 0}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-all disabled:opacity-30 ml-1"
                title="ล้างประวัติข้อความทั้งหมด"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Mic Permission Error Alert */}
          {micPermissionError && (
            <div className="p-3 bg-rose-50 border-b border-rose-200 text-rose-800 text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
                <span>ไมโครโฟนถูกบล็อก กรุณาอนุญาตการเข้าถึงไมโครโฟนในเบราว์เซอร์</span>
              </div>
              <button
                onClick={startListening}
                className="px-3 py-1 bg-rose-600 text-white rounded-lg text-xs font-semibold"
              >
                ลองใหม่อีกครั้ง
              </button>
            </div>
          )}

          {/* Live Interim Speech Stream Indicator & Live Chunk Controller */}
          {isListening && (
            <div className="px-4 py-2 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between gap-3 text-xs text-emerald-900 transition-all shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="font-bold text-emerald-800 shrink-0">กำลังฟัง:</span>
                </div>
                <div className="flex-1 truncate font-mono text-xs text-emerald-800 font-medium">
                  {interimSpeechText ? (
                    <span className="bg-emerald-100/80 px-2 py-0.5 rounded text-emerald-900 font-semibold animate-pulse">
                      &ldquo;{interimSpeechText}&rdquo;
                    </span>
                  ) : (
                    <span className="text-emerald-600/80 italic">กำลังรอเสียงพูด... (พูดใส่ไมโครโฟนได้ทันที)</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {/* Visual Audio Wave */}
                <div className="flex items-center gap-0.5 h-3.5 bg-emerald-200/80 px-1.5 rounded">
                  <div
                    className="w-1 bg-emerald-700 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(25, micAudioLevel)}%` }}
                  />
                  <div
                    className="w-1 bg-emerald-700 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(20, micAudioLevel * 0.8)}%` }}
                  />
                  <div
                    className="w-1 bg-emerald-700 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(15, micAudioLevel * 0.6)}%` }}
                  />
                </div>

                {/* Live Chunk Status Badge */}
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 bg-white text-[11px] font-semibold text-emerald-800 border border-emerald-300 rounded-md shadow-2xs">
                  <Timer className="w-3 h-3 text-emerald-600" />
                  <span>ตัดวรรค ~{(config.chunkSilenceMs || 900) / 1000}s</span>
                </span>

                {/* Manual Cut Now Button */}
                {interimSpeechText && (
                  <button
                    type="button"
                    onClick={handleForceCommitInterim}
                    className="px-2.5 py-1 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-md text-[11px] font-bold flex items-center gap-1 transition-all shadow-2xs cursor-pointer animate-bounce"
                    title="ตัดวรรคและส่งท่อนนี้ให้ AI แปลทันที"
                  >
                    <Scissors className="w-3 h-3" />
                    <span>ตัดแปลทันที</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Transcripts List Container */}
          <div
            ref={transcriptScrollRef}
            className="flex-1 p-3.5 sm:p-6 overflow-y-auto space-y-3.5"
          >
            {transcripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-center text-[#DE5C8E]">
                  <Mic className="w-7 h-7" />
                </div>
                <div className="space-y-1 max-w-sm">
                  <div className="font-bold text-slate-700 text-sm">พร้อมรับเสียงจากไมโครโฟน</div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    กดปุ่ม <strong>&quot;เริ่มแปลสด&quot;</strong> ด้านบน จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
                  </p>
                </div>
              </div>
            ) : (
              transcripts.map((item, index) => {
                const isEditing = editingItemId === item.id;
                const isLatest = index === transcripts.length - 1;

                return (
                  <div
                    key={item.id}
                    className={`p-4 rounded-xl border transition-all shadow-xs ${
                      isEditing
                        ? 'bg-amber-50/90 border-amber-300 ring-2 ring-amber-200'
                        : isLatest
                        ? 'bg-white border-[#DE5C8E]/40 ring-1 ring-[#DE5C8E]/20'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {isEditing ? (
                      /* Inline Editor */
                      <div className="space-y-2.5">
                        <div>
                          <label className="text-xs font-bold text-slate-600 block mb-1">
                            ประโยคต้นฉบับ:
                          </label>
                          <input
                            type="text"
                            value={editOriginalText}
                            onChange={(e) => setEditOriginalText(e.target.value)}
                            className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-lg outline-none focus:border-[#DE5C8E]"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-slate-600 block mb-1">
                            คำแปล:
                          </label>
                          <input
                            type="text"
                            value={editTranslatedText}
                            onChange={(e) => setEditTranslatedText(e.target.value)}
                            className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-lg font-bold text-slate-900 outline-none focus:border-[#DE5C8E]"
                          />
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <button
                            type="button"
                            onClick={() => retranslateItem(item)}
                            className="px-3 py-1.5 text-xs text-[#DE5C8E] bg-[#DE5C8E]/10 hover:bg-[#DE5C8E]/20 rounded-lg font-semibold flex items-center gap-1.5 transition-all"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>ให้ AI แปลใหม่</span>
                          </button>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={cancelEditing}
                              className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="button"
                              onClick={() => saveCorrection(item.id)}
                              className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>บันทึก</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Clean Item Display */
                      <div className="space-y-1.5">
                        {/* Meta header row */}
                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-slate-400">
                              {new Date(item.timestamp).toLocaleTimeString()}
                            </span>
                            {config.showLatency && item.latencyMs ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 font-mono text-[10px] text-slate-600 border border-slate-200">
                                <Zap className="w-3 h-3 text-amber-500" />
                                <span>{item.latencyMs}ms</span>
                              </span>
                            ) : null}
                            {item.isEdited && (
                              <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md font-medium border border-amber-200">
                                แก้ไขแล้ว
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleCopyItem(item)}
                              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                              title="คัดลอกข้อความ"
                            >
                              {copiedItemId === item.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => startEditing(item)}
                              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                              title="แก้ไขคำแปล"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deleteItem(item.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-all"
                              title="ลบรายการนี้"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Source text (if enabled) */}
                        {config.showOriginal && item.originalText && (
                          <div className="text-xs text-slate-500 font-medium leading-relaxed">
                            {item.originalText}
                          </div>
                        )}

                        {/* Primary Translated text */}
                        <div className={`${getTextSizeClass()} font-bold text-slate-900 leading-snug tracking-tight`}>
                          {item.translatedText}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* ─────────────────────────────────────────────────────────────
              BOTTOM TEST & SIMULATION INPUT BAR (Instant Translation Check)
          ────────────────────────────────────────────────────────────── */}
          <div className="p-3 bg-white border-t border-slate-200 shrink-0 space-y-2">
            {/* Quick Test Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] no-scrollbar pb-0.5">
              <span className="text-slate-400 font-semibold shrink-0 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-[#DE5C8E]" />
                <span>ตัวอย่างทดสอบ:</span>
              </span>
              {config.sourceLang === 'th-TH' ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('สวัสดีครับ ยินดีต้อนรับสู่การประชุมประจำปี')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;สวัสดีครับ ยินดีต้อนรับสู่การประชุม&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('ปัญญาประดิษฐ์และ Machine Learning มีความสำคัญต่อองค์กร')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;ปัญญาประดิษฐ์และ Machine Learning&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('ตัวชี้วัดความสำเร็จและ ROI ปีนี้เติบโต 25%')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;ตัวชี้วัดความสำเร็จและ ROI&rdquo;
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('Good morning everyone and welcome to the conference.')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;Good morning everyone and welcome&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('Today we will discuss Artificial Intelligence and Machine Learning.')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;Artificial Intelligence & Machine Learning&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTestText('Let us review our key performance indicators and return on investment.')}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] hover:border-pink-200 border border-slate-200 text-slate-700 rounded-md font-medium shrink-0 transition-all cursor-pointer"
                  >
                    &ldquo;KPI & Return on investment&rdquo;
                  </button>
                </>
              )}
            </div>

            {/* Test Input Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendTestText();
              }}
              className="flex items-center gap-2"
            >
              <div className="relative flex-1">
                <input
                  type="text"
                  value={testInputText}
                  onChange={(e) => setTestInputText(e.target.value)}
                  placeholder={
                    config.sourceLang === 'th-TH'
                      ? 'พิมพ์ข้อความภาษาไทยเพื่อทดสอบแปลเป็นอังกฤษ (กด Enter หรือคลิกส่ง)...'
                      : 'Type English text to test translation to Thai (press Enter or click Send)...'
                  }
                  className="w-full pl-3 pr-8 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] transition-all text-slate-800 placeholder:text-slate-400"
                />
                {testInputText && (
                  <button
                    type="button"
                    onClick={() => setTestInputText('')}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                type="submit"
                disabled={!testInputText.trim()}
                className="px-4 py-2 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-bold transition-all shadow-2xs disabled:opacity-40 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                <span>แปลทันที</span>
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
