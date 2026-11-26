import { Controller, Get, Query } from '@nestjs/common';
import { InspectionStore } from './inspection.store';
import { GeminiResultStore } from './gemini-result.store';
import type { Inspection } from './inspection.types';
import { inspectionDefectNames, type InspectionRecordDefectView } from './inspection-record.types';

type Verdict = 'OK' | 'NG' | 'HOLD';
type VerdictCounts = Record<Verdict | 'NONE', number>;

const defectCodes = ['D01', 'D02', 'D03', 'D04'] as const;
const productIds = ['P-SILVER', 'P-WHITE', 'P-BLACK'] as const;

// AI 판독의 "불량유형" 글에서 불량 코드를 찾습니다.
const aiDefectKeywords: Record<(typeof defectCodes)[number], RegExp> = {
  D01: /스크래치|긁힘|긁힌|scratch/i,
  D02: /찍힘|찍힌|움푹|함몰|덴트|dent/i,
  D03: /라벨|label/i,
  D04: /뚜껑|조립|lid/i,
};

const emptyCounts = (): VerdictCounts => ({ OK: 0, NG: 0, HOLD: 0, NONE: 0 });

@Controller('api/dashboard')
export class DashboardController {
  constructor(
    private readonly store: InspectionStore,
    private readonly geminiResults: GeminiResultStore,
  ) {}

  @Get()
  async getDashboard(@Query('date') requestedDate?: string) {
    const [inspections, latestResults] = await Promise.all([
      this.store.getAll(),
      this.geminiResults.getLatestResultsByInspection(),
    ]);
    const mostRecent = inspections
      .map((inspection) => inspection.inspected_at.slice(0, 10))
      .sort((a, b) => b.localeCompare(a))[0] ?? '';
    const date = inspections.length === 0 ? '' : requestedDate || mostRecent;
    const daily = date
      ? inspections.filter((inspection) => inspection.inspected_at.slice(0, 10) === date)
      : [];

    const ai = emptyCounts();
    const human = emptyCounts();
    const aiDefects: Record<string, number> = { D01: 0, D02: 0, D03: 0, D04: 0 };
    const humanDefects: Record<string, number> = { D01: 0, D02: 0, D03: 0, D04: 0 };
    const byProduct = Object.fromEntries(
      productIds.map((id) => [id, { total: 0, ai_ng: 0, human_ng: 0 }]),
    ) as Record<string, { total: number; ai_ng: number; human_ng: number }>;
    let compared = 0;
    let matched = 0;
    const recent: Array<{
      inspection_id: string;
      product_id: string;
      inspected_at: string;
      image: string | null;
      memo: string;
      ai: Verdict | null;
      human: Verdict | null;
      causes: string[];
    }> = [];

    for (const inspection of daily) {
      const latest = latestResults.get(inspection.inspection_id);
      const aiVerdict: Verdict | null = latest ? latest.result.판정 : null;
      const humanVerdict: Verdict | null = inspection.decision;
      const humanDefectList =
        (inspection as Inspection & { defects?: InspectionRecordDefectView[] }).defects ?? [];

      ai[aiVerdict ?? 'NONE'] += 1;
      human[humanVerdict ?? 'NONE'] += 1;

      const aiCodes = aiVerdict && aiVerdict !== 'OK'
        ? defectCodes.filter((code) => aiDefectKeywords[code].test(latest?.result.불량유형 ?? ''))
        : [];
      for (const code of aiCodes) aiDefects[code] += 1;
      for (const defect of humanDefectList) {
        if (defect.defect_code in humanDefects) humanDefects[defect.defect_code] += 1;
      }

      const product = byProduct[inspection.product_id];
      if (product) {
        product.total += 1;
        if (aiVerdict === 'NG') product.ai_ng += 1;
        if (humanVerdict === 'NG') product.human_ng += 1;
      }

      if (aiVerdict && humanVerdict) {
        compared += 1;
        if (aiVerdict === humanVerdict) matched += 1;
      }

      const isProblem = (aiVerdict && aiVerdict !== 'OK') || (humanVerdict && humanVerdict !== 'OK');
      if (isProblem) {
        const causeCodes = humanDefectList.length > 0
          ? humanDefectList.map((defect) => defect.defect_code)
          : aiCodes;
        recent.push({
          inspection_id: inspection.inspection_id,
          product_id: inspection.product_id,
          inspected_at: inspection.inspected_at,
          image: inspection.images[0] ?? null,
          memo: inspection.memo,
          ai: aiVerdict,
          human: humanVerdict,
          causes: causeCodes.map((code) => inspectionDefectNames[code] ?? code),
        });
      }
    }

    recent.sort((left, right) => right.inspected_at.localeCompare(left.inspected_at));

    return {
      date,
      total: daily.length,
      ai,
      human,
      agreement: {
        compared,
        matched,
        rate: compared === 0 ? null : Math.round((matched / compared) * 1000) / 10,
      },
      defects: defectCodes.map((code) => ({
        defect_code: code,
        defect_name: inspectionDefectNames[code],
        ai: aiDefects[code],
        human: humanDefects[code],
      })),
      by_product: productIds.map((id) => ({ product_id: id, ...byProduct[id] })),
      recent: recent.slice(0, 8),
    };
  }
}
