export type StorageMode = 'mock' | 'live';

export function getStorageMode(): StorageMode {
  return process.env.STORAGE_MODE === 'live' ? 'live' : 'mock';
}

export function getStorageLabel(): string {
  return getStorageMode() === 'live'
    ? 'Google 시트·드라이브(live)'
    : '내 컴퓨터(mock)';
}