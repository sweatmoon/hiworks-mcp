import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import { serviceConfig } from '../config.js';

/** LLM 에 넘기는 압축된 메일 (본문은 앞부분만) */
export interface CompactEmail {
  id: number;
  direction: 'sent' | 'received';
  date: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  threadSize: number;
  projectHint: string | null;
}

export const ActivitySchema = z.object({
  description: z.string().describe('수행한 업무 또는 받은 요청을 한 문장으로. 메일에 적힌 사실만.'),
  activity_type: z.enum(['sent_work', 'received_request', 'follow_up', 'other']),
  project_name: z.string().nullable().describe('사업/프로젝트명. 메일에서 알 수 없으면 null'),
  evidence_email_ids: z.array(z.number()).describe('근거가 되는 메일 id. 반드시 입력 목록의 id 만 사용'),
  confidence: z.number().min(0).max(1),
});

export const ExtractionSchema = z.object({
  activities: z.array(ActivitySchema),
  unresolved_requests: z.array(
    z.object({
      description: z.string(),
      requester: z.string(),
      evidence_email_ids: z.array(z.number()),
    })
  ),
  notes: z.string().describe('근거가 불충분해 확인이 필요한 점. 없으면 빈 문자열'),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export interface WorklogLLM {
  readonly model: string;
  extract(workDate: string, emails: CompactEmail[], projectNames: string[]): Promise<Extraction>;
}

const SYSTEM_PROMPT = `당신은 업무일지 작성을 돕는 분석가입니다. 입력으로 특정 날짜의 이메일 목록(id, 방향, 발신자, 제목, 본문 앞부분)을 받습니다.

규칙:
- 메일에 실제로 적힌 내용만 업무 활동으로 기록합니다. 메일에 없는 업무를 추측하거나 지어내지 않습니다.
- 발신(sent) 메일은 사용자가 수행한 업무의 근거입니다. 수신(received) 메일은 사용자에게 온 요청·정보의 근거입니다.
- 같은 스레드(제목이 같은 메일)는 하나의 활동으로 합칩니다.
- 모든 활동에는 evidence_email_ids 로 근거 메일 id 를 넣습니다. 입력에 없는 id 는 절대 쓰지 않습니다.
- 근거가 약하면 confidence 를 낮추고 notes 에 이유를 적습니다.
- project_name 은 제목 태그([사업명]), 본문, 또는 제공된 사업명 목록과 일치할 때만 채웁니다.
- 광고·뉴스레터·자동 알림은 활동에서 제외합니다.
- 한국어로 간결하게 작성합니다.`;

export class AnthropicWorklogLLM implements WorklogLLM {
  private client: Anthropic;
  readonly model: string;

  constructor(model: string = serviceConfig.anthropicModel) {
    this.client = new Anthropic();
    this.model = model;
  }

  async extract(workDate: string, emails: CompactEmail[], projectNames: string[]): Promise<Extraction> {
    const payload = {
      work_date: workDate,
      known_projects: projectNames,
      emails,
    };
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `다음 메일 목록에서 ${workDate} 의 업무 활동과 미해결 요청을 추출하세요.\n\n${JSON.stringify(payload, null, 1)}`,
        },
      ],
      output_config: { format: zodOutputFormat(ExtractionSchema) },
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`모델이 요청을 거부했습니다: ${response.stop_details?.explanation ?? ''}`);
    }
    if (!response.parsed_output) throw new Error('모델 응답을 구조화 형식으로 해석하지 못했습니다.');
    return response.parsed_output;
  }
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']);
}

let override: WorklogLLM | null = null;
/** 테스트에서 가짜 LLM 을 주입할 때 사용 */
export function setWorklogLLM(llm: WorklogLLM | null): void {
  override = llm;
}

export function getWorklogLLM(): WorklogLLM {
  if (override) return override;
  if (!hasAnthropicCredentials()) {
    throw new Error('ANTHROPIC_API_KEY 가 설정되어 있지 않아 AI 업무일지 추출을 실행할 수 없습니다. (mode="rules" 로 규칙 기반 추출은 가능)');
  }
  return new AnthropicWorklogLLM();
}
