export type StorageMode = 'mock' | 'live';
export type GeminiMode = 'off' | 'mock' | 'live';
export type NotebookLMMode = 'off' | 'mock' | 'live';

export interface GeminiInfo {
  mode: GeminiMode;
  label: string;
  error?: string;
}

export interface StorageInfo {
  storage: StorageMode;
  label: string;
  gemini_mode: GeminiMode;
  gemini_label: string;
  notebooklm_mode: NotebookLMMode;
  notebooklm_label: string;
}

export function getStorageMode(): StorageMode {
  return process.env.STORAGE_MODE === 'live' ? 'live' : 'mock';
}

export function getGeminiInfo(): GeminiInfo {
  const configuredMode = process.env.GEMINI_MODE;
  const storage = getStorageMode();

  if (configuredMode && !['off', 'mock', 'live'].includes(configuredMode)) {
    return {
      mode: 'off',
      label: '꺼짐(off)',
      error: 'GEMINI_MODE는 off, mock, live 가운데 하나여야 합니다.',
    };
  }
  if (storage === 'mock' && configuredMode === 'live') {
    return {
      mode: 'off',
      label: '꺼짐(off)',
      error: 'STORAGE_MODE가 mock일 때 GEMINI_MODE는 live로 설정할 수 없습니다.',
    };
  }
  if (storage === 'live' && configuredMode === 'mock') {
    return {
      mode: 'off',
      label: '꺼짐(off)',
      error: 'STORAGE_MODE가 live일 때 GEMINI_MODE는 mock으로 설정할 수 없습니다.',
    };
  }

  const mode: GeminiMode = configuredMode === 'off'
    ? 'off'
    : configuredMode === 'mock'
      ? 'mock'
      : configuredMode === 'live'
        ? 'live'
        : storage === 'live'
          ? 'live'
          : 'off';
  const labels: Record<GeminiMode, string> = {
    off: '꺼짐(off)',
    mock: '연습용(mock)',
    live: '실제 Gemini(live)',
  };

  return { mode, label: labels[mode] };
}

export function getStorageInfo(): StorageInfo {
  const storage = getStorageMode();
  const gemini = getGeminiInfo();
  const notebookLM = getNotebookLMInfo();
  return {
    storage,
    label: storage === 'live' ? 'Google 시트·드라이브(live)' : '내 컴퓨터(mock)',
    gemini_mode: gemini.mode,
    gemini_label: gemini.label,
    notebooklm_mode: notebookLM.mode,
    notebooklm_label: notebookLM.label,
  };
}

export function getNotebookLMInfo(): GeminiInfo & { mode: NotebookLMMode } {
  const configuredMode = process.env.NOTEBOOKLM_MODE || undefined;
  const storage = getStorageMode();

  if (configuredMode && !['off', 'mock', 'live'].includes(configuredMode)) {
    return {
      mode: 'off',
      label: '꺼짐(off)',
      error: 'NOTEBOOKLM_MODE는 off, mock, live 가운데 하나여야 합니다.',
    };
  }
  if (storage === 'live' && configuredMode === 'mock') {
    return {
      mode: 'off',
      label: '꺼짐(off)',
      error: 'STORAGE_MODE가 live일 때 NOTEBOOKLM_MODE는 mock으로 설정할 수 없습니다.',
    };
  }

  const mode: NotebookLMMode = configuredMode === 'off'
    ? 'off'
    : configuredMode === 'mock'
      ? 'mock'
      : configuredMode === 'live'
        ? 'live'
        : storage === 'mock'
          ? 'mock'
          : 'off';
  const labels: Record<NotebookLMMode, string> = {
    off: '꺼짐(off)',
    mock: '연습용(mock)',
    live: '실제 질의(live)',
  };

  return { mode, label: labels[mode] };
}

export function validateNotebookLMMode(): void {
  const info = getNotebookLMInfo();
  if (info.error) throw new Error(info.error);
}

export function getStorageLabel(): string {
  return getStorageInfo().label;
}