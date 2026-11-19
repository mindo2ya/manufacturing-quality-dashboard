import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Inspection } from './inspection.types';
import type { GeminiResultFields, GeminiResultRecord, GeminiRunState, GeminiRunStatus } from './gemini-result.types';
import { getGeminiInfo, getStorageInfo } from './storage-mode';

interface RunState {
  state: GeminiRunState;
  error?: string;
}

@Injectable()
export class GeminiResultStore {
  private readonly filePath = path.join(process.cwd(), 'runtime', 'gemini-results.json');
  private readonly runStates = new Map<string, RunState>();

  async getInspectionIdsWithResults(): Promise<Set<string>> {
    const results = await this.readResults();
    return new Set(results.map((record) => record.inspection_id));
  }

  async getReviewPendingInspectionIds(inspections: Inspection[]): Promise<Set<string>> {
    const results = await this.readResults();
    const latestByInspection = new Map<string, GeminiResultRecord>();
    for (const result of results) {
      const latest = latestByInspection.get(result.inspection_id);
      if (!latest || result.created_at.localeCompare(latest.created_at) > 0) {
        latestByInspection.set(result.inspection_id, result);
      }
    }

    const pending = new Set<string>();
    for (const inspection of inspections) {
      const latest = latestByInspection.get(inspection.inspection_id);
      if (latest && !this.isStale(latest, inspection)) pending.add(inspection.inspection_id);
    }
    return pending;
  }

  async getStatus(inspection: Inspection): Promise<GeminiRunStatus> {
    const results = (await this.readResults(inspection.inspection_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    const current = this.runStates.get(inspection.inspection_id) ?? { state: 'idle' as const };
    const latest = results[0];
    const stale = latest ? this.isStale(latest, inspection) : false;

    return {
      mode: getGeminiInfo().mode,
      state: current.state,
      ...(current.state === 'failed' && current.error ? { error: current.error } : {}),
      results,
      stale,
    };
  }

  private isStale(result: GeminiResultRecord, inspection: Inspection): boolean {
    return result.product_id !== inspection.product_id ||
      result.weight_g !== inspection.weight_g ||
      JSON.stringify(result.images) !== JSON.stringify(inspection.images);
  }

  async startMock(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<GeminiRunStatus> {
    if (this.runStates.get(inspection.inspection_id)?.state === 'running') {
      return this.getStatus(inspection);
    }
    this.runStates.set(inspection.inspection_id, { state: 'running' });
    const snapshot: Inspection = { ...inspection, images: [...inspection.images] };

    setTimeout(() => {
      void this.completeMock(snapshot, revision, instructionName, instructionText);
    }, 1500);

    return this.getStatus(snapshot);
  }

  async startLive(): Promise<GeminiRunStatus> {
    const mode = getGeminiInfo().mode;
    throw new Error(`실제 Gemini 판독 서버 기능은 아직 준비되지 않았습니다. (현재 모드: ${mode})`);
  }

  private async completeMock(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<void> {
    try {
      const record: GeminiResultRecord = {
        result_id: `GR-${randomBytes(4).toString('hex')}`,
        inspection_id: inspection.inspection_id,
        created_at: this.koreanTimestamp(),
        mode: 'mock',
        revision,
        instruction_name: instructionName,
        instruction_text: instructionText,
        product_id: inspection.product_id,
        weight_g: inspection.weight_g,
        images: [...inspection.images],
        result: this.makeMockResult(inspection, revision),
      };
      await this.saveResult(record);
      this.runStates.set(inspection.inspection_id, { state: 'idle' });
    } catch (error) {
      this.runStates.set(inspection.inspection_id, {
        state: 'failed',
        error: error instanceof Error ? error.message : '판독 결과를 저장하지 못했습니다.',
      });
    }
  }

  private makeMockResult(inspection: Inspection, revision: 'Rev.A' | 'Rev.B'): GeminiResultFields {
    const upperWeight = revision === 'Rev.A'
      ? { 'P-SILVER': 355, 'P-WHITE': 455, 'P-BLACK': 555 }[inspection.product_id]
      : { 'P-SILVER': 354, 'P-WHITE': 455, 'P-BLACK': 555 }[inspection.product_id];
    const weightText = inspection.weight_g === null ? '미측정' : `${inspection.weight_g}g`;

    return {
      판정: 'HOLD',
      불량유형: '[모의 테스트 초안] 실제 사진을 확인하세요.',
      '관찰·수치 근거': `[모의 테스트 초안] 입력 중량: ${weightText}. 사진과 실제 제품 상태는 담당자가 확인해야 합니다.`,
      '적용 기준과 출처': `[모의 테스트 초안] ${revision}, ${inspection.product_id} 기준 중량 상한 ${upperWeight}g.`,
      '권고 조치': '[모의 테스트 초안] 사진과 측정값을 확인하고 담당자가 직접 판정하세요.',
      '사람 승인 필요 여부': '[모의 테스트 초안] 필요',
    };
  }

  private async readResults(inspectionId?: string): Promise<GeminiResultRecord[]> {
    let results: GeminiResultRecord[];
    if (getStorageInfo().storage === 'live') {
      throw new Error('Google 저장소의 Gemini 판독 결과는 다음 작업에서 지원합니다.');
    }
    if (!existsSync(this.filePath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    results = Array.isArray(parsed)
      ? parsed as GeminiResultRecord[]
      : Array.isArray((parsed as { results?: unknown })?.results)
        ? (parsed as { results: GeminiResultRecord[] }).results
        : [];
    return inspectionId ? results.filter((item) => item.inspection_id === inspectionId) : results;
  }

  private async saveResult(result: GeminiResultRecord): Promise<void> {
    if (getStorageInfo().storage === 'live') {
      throw new Error('Google 저장소의 Gemini 판독 결과는 다음 작업에서 지원합니다.');
    }
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const results = await this.readResults();
    results.push(result);
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }

  private koreanTimestamp(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()).replace(',', '');
  }
}