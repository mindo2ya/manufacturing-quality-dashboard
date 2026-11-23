import { HttpException, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Inspection } from './inspection.types';
import type { GeminiResultFields, GeminiResultRecord, GeminiRunState, GeminiRunStatus } from './gemini-result.types';
import { GoogleWebAppClient } from './google-web-app.client';
import { getGeminiInfo, getStorageInfo } from './storage-mode';
import { EvidenceLinkStore } from './evidence-link.store';
import type { EvidenceLinkRecord } from './evidence-link.types';

const resultLabels = [
  '판정',
  '불량유형',
  '관찰·수치 근거',
  '적용 기준과 출처',
  '권고 조치',
  '사람 승인 필요 여부',
] as const;

const productNames: Record<string, string> = {
  'P-SILVER': '텀블러 실버',
  'P-WHITE': '텀블러 화이트',
  'P-BLACK': '텀블러 블랙',
};

function normalizeGeminiResult(value: unknown): GeminiResultFields | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!['OK', 'NG', 'HOLD'].includes(record['판정'] as string)) return null;
  if (!resultLabels.every((label) => typeof record[label] === 'string')) return null;
  return Object.fromEntries(resultLabels.map((label) => [label, record[label]])) as unknown as GeminiResultFields;
}

interface GoogleGeminiResultRecord extends Omit<GeminiResultRecord, 'weight_g' | 'images' | 'result'> {
  weight_g: number | string | null;
  images: unknown;
  result: unknown;
}

interface GoogleReviewData {
  gemini_results?: GoogleGeminiResultRecord[];
  evidence_links?: EvidenceLinkRecord[];
}

const parseJsonCell = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

interface RunState {
  state: GeminiRunState;
  error?: string;
}

@Injectable()
export class GeminiResultStore {
  private readonly filePath = path.join(process.cwd(), 'runtime', 'gemini-results.json');
  private readonly runStates = new Map<string, RunState>();

  constructor(
    private readonly google: GoogleWebAppClient,
    private readonly evidenceLinks: EvidenceLinkStore,
  ) {}

  async getInspectionIdsWithResults(): Promise<Set<string>> {
    const results = await this.readResults();
    return new Set(results.map((record) => record.inspection_id));
  }

  async getReviewPendingInspectionIds(inspections: Inspection[]): Promise<Set<string>> {
    let results: GeminiResultRecord[];
    let links: EvidenceLinkRecord[];
    if (getStorageInfo().storage === 'live') {
      const response = await this.google.call<GoogleReviewData>('read', {
        tabs: ['gemini_results', 'evidence_links'],
      });
      results = this.normalizeGoogleResults(response.gemini_results ?? []);
      links = response.evidence_links ?? [];
    } else {
      results = await this.readResults();
      links = this.readLocalEvidenceLinks();
    }
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
      if (!latest) continue;
      if (this.isStale(latest, inspection)) {
        pending.add(inspection.inspection_id);
        continue;
      }
      const link = links
        .filter((record) => record.inspection_id === inspection.inspection_id && record.draft_id === latest.result_id)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
      const reviewedAsMatch = link?.status === 'VERIFIED_BY_USER' || link?.status === 'MOCK_USER_REVIEWED';
      if (!reviewedAsMatch) {
        pending.add(inspection.inspection_id);
      }
    }
    return pending;
  }

  async getStatus(inspection: Inspection): Promise<GeminiRunStatus> {
    const results = (await this.readResults(inspection.inspection_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    const current = this.runStates.get(inspection.inspection_id) ?? { state: 'idle' as const };
    const latest = results[0];
    const stale = latest ? this.isStale(latest, inspection) : false;

    const link = latest
      ? await this.evidenceLinks.getLatestForDraft(inspection.inspection_id, latest.result_id)
      : null;

    return {
      mode: getGeminiInfo().mode,
      state: current.state,
      ...(current.state === 'failed' && current.error ? { error: current.error } : {}),
      results,
      stale,
      link,
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

  async startLive(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<GeminiRunStatus> {
    if (this.runStates.get(inspection.inspection_id)?.state === 'running') {
      return { mode: 'live', state: 'running', results: [], stale: false, link: null };
    }
    this.runStates.set(inspection.inspection_id, { state: 'running' });
    const snapshot: Inspection = { ...inspection, images: [...inspection.images] };
    void this.completeLive(snapshot, revision, instructionName, instructionText);
    return { mode: 'live', state: 'running', results: [], stale: false, link: null };
  }

  private async completeLive(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<void> {
    try {
      const standard = readFileSync(
        path.join(process.cwd(), 'standards', `notebooklm-${revision}.md`),
        'utf8',
      );
      const imageIds = inspection.images.map((image) => {
        const match = /^\/api\/drive\/([^/?#]+)$/.exec(image);
        if (!match) throw new Error('등록된 사진 주소를 확인하세요. Google 저장으로 등록한 검사만 실제 판독할 수 있습니다.');
        return decodeURIComponent(match[1]);
      });
      const rawResult = await this.google.call<unknown>('runGemini', {
        instruction: instructionText,
        product_name: productNames[inspection.product_id] ?? '제품 미지정',
        weight: inspection.weight_g === null ? '미측정' : `${inspection.weight_g}g`,
        revision,
        standard,
        imageIds,
      });
      const result = normalizeGeminiResult(rawResult);
      if (!result) throw new Error('AI 응답 형식이 올바르지 않아 판독하지 못했습니다.');

      await this.saveResult({
        result_id: `GR-${randomBytes(4).toString('hex')}`,
        inspection_id: inspection.inspection_id,
        created_at: this.koreanTimestamp(),
        mode: 'live',
        revision,
        instruction_name: instructionName,
        instruction_text: instructionText,
        product_id: inspection.product_id,
        weight_g: inspection.weight_g,
        images: [...inspection.images],
        result,
      });
      this.runStates.set(inspection.inspection_id, { state: 'idle' });
    } catch (error) {
      this.runStates.set(inspection.inspection_id, {
        state: 'failed',
        error: this.readErrorMessage(error),
      });
    }
  }

  private readErrorMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      if (typeof response === 'object' && response !== null) {
        const body = response as { message?: unknown; error?: unknown };
        if (typeof body.message === 'string') return body.message;
        if (Array.isArray(body.message)) return body.message.join(' ');
        if (typeof body.error === 'string') return body.error;
      }
    }
    return error instanceof Error ? error.message : '판독하지 못했습니다.';
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
      const values = inspectionId ? { inspection_id: inspectionId } : {};
      const response = await this.google.call<{ results?: GoogleGeminiResultRecord[] }>('listGeminiResults', values);
      return this.normalizeGoogleResults(response.results ?? []);
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

  private normalizeGoogleResults(records: GoogleGeminiResultRecord[]): GeminiResultRecord[] {
    return records.map((record) => {
      const result = normalizeGeminiResult(parseJsonCell(record.result));
      if (!result) throw new Error('저장된 판독 결과를 읽을 수 없습니다.');
      return {
        ...record,
        weight_g: record.weight_g === null || record.weight_g === '' ? null : Number(record.weight_g),
        images: Array.isArray(parseJsonCell(record.images))
          ? (parseJsonCell(record.images) as unknown[]).filter((image): image is string => typeof image === 'string')
          : [],
        result,
      };
    });
  }

  private readLocalEvidenceLinks(): EvidenceLinkRecord[] {
    const filePath = path.join(process.cwd(), 'runtime', 'evidence-links.json');
    if (!existsSync(filePath)) return [];
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value as EvidenceLinkRecord[] : [];
  }

  private async saveResult(result: GeminiResultRecord): Promise<void> {
    if (getStorageInfo().storage === 'live') {
      const saved = await this.google.call<{ saved: number }>('saveGeminiResult', {
        record: {
          ...result,
          images: JSON.stringify(result.images),
          result: JSON.stringify(result.result),
        },
      });
      if (saved.saved !== 1) throw new Error('판독 결과를 저장하지 못했습니다.');
      return;
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