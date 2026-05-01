/**
 * 화접몽 한의원 GEO 콘텐츠 생성기 v2.1
 * 3단계 파이프라인: 리서치 → 전략 → 프로덕션
 *
 * v2.1 개선사항:
 * - 제목에 괄호 지시사항 포함되는 버그 수정
 * - FAQ는 FAQ 콘텐츠 타입에만 포함
 * - 토픽 중심 콘텐츠 생성 강화
 * - Gemini API 자동 재시도 + 폴백 모델
 * - 레퍼런스 콘텐츠 학습 시스템
 * - GEO AI 인용 최적화
 * - 의료법 56조·7항 준수
 * - 가짜인용 제거 + 의료 면책 조항
 */

import { BRAND, AI_CONFIG, CONTENT_TYPES } from './config.js';
import { generateSchemas } from './schema-generator.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ─── 콘텐츠 다양성 시스템 ───

// 글쓰기 톤 변형 (랜덤화)
const WRITING_STYLES = [
  { id: 'warm-expert', desc: '따뜻하고 전문적인 톤. 환자의 불안감을 덜어주는 의사의 어조로 작성하세요.' },
  { id: 'educational', desc: '교육적이고 설명적인 톤. 의학 지식을 쉽게 풀어 설명하는 강사의 어조로 작성하세요.' },
  { id: 'empathetic', desc: '공감형 톤. 환자가 겪는 고민과 불편함에 깊이 공감하며 해결책을 안내하는 어조로 작성하세요.' },
  { id: 'practical', desc: '실용적이고 간결한 톤. 환자가 바로 실천할 수 있는 정보 위주로, 군더더기 없이 작성하세요.' },
  { id: 'storytelling', desc: '이야기형 톤. 환자가 겪는 일상적 상황에서 시작하여 자연스럽게 의학 정보로 연결하는 내러티브 방식으로 작성하세요.' },
];

// 도입부 스타일 변형
const INTRO_STYLES = [
  '환자가 흔히 겪는 상황이나 고민으로 시작하세요 (예: "거울을 볼 때마다 신경 쓰이는...")',
  '핵심 정의문으로 시작하세요 (예: "~은(는) ~에 의해 발생하는 피부 질환입니다")',
  '흥미로운 의학적 사실이나 통계로 시작하세요 (단, 출처 불명 데이터 금지)',
  '계절이나 환경 변화에 연결하여 시작하세요 (예: "환절기가 되면 유독 심해지는...")',
  '자주 받는 질문으로 시작하세요 (예: "진료실에서 가장 많이 듣는 질문 중 하나가...")',
];

// 콘텐츠 구조 변형 (콘텐츠 타입별) - FAQ 타입 외에는 FAQ 섹션 제거
const STRUCTURE_TEMPLATES = {
  'comprehensive-guide': [
    '도입 → 정의 → 원인 → 증상 유형 → 진단 → 치료법 → 생활 관리',
    '도입 → Q&A 형식 정의 → 원인과 메커니즘 → 증상 단계별 설명 → 치료 접근법 → 예방과 관리',
    '도입 → 핵심 요약(한눈에 보기) → 원인 상세 → 증상 체크리스트 → 치료 옵션 비교 → 한방 치료 소개 → 일상 관리법',
  ],
  'korean-medicine-treatment': [
    '도입 → 한의학적 원인 분석 → 체질별 접근 → 치료 프로세스 → 치료 후 관리',
    '도입 → 양방 vs 한방 관점 차이 → 한의학 진단 방법 → 대표 치료법 상세 → 치료 기간과 경과 → 생활 습관 개선',
    '도입 → 왜 한방 치료인가 → 체질 진단의 중요성 → 치료 과정 단계별 안내 → 치료 효과와 기대 → 관리 요령',
  ],
  'faq': [
    '도입(핵심 질문 소개) → 원인 관련 Q&A → 증상 관련 Q&A → 치료 관련 Q&A → 관리 관련 Q&A → 비용/기간 Q&A',
    '도입 → 초보 환자 질문 모음 → 치료 과정 질문 → 한방 치료 특화 질문 → 생활 관리 질문 → 재발 방지 질문',
  ],
  'case-study': [
    '도입 → 일반적 증상 양상 → 한의학적 진단 과정 → 치료 계획 수립 → 치료 경과 → 관리 포인트',
    '도입 → 흔한 내원 사례 유형 → 체질별 차이 → 치료 접근법 → 경과 관찰 포인트 → 재발 방지 전략',
  ],
  'comparison': [
    '도입 → 치료 옵션 개요 → 각 치료법 특징 → 한방 치료의 장점 → 치료 선택 가이드',
    '도입 → 환자별 고민 유형 → 다양한 치료 접근법 → 한의학적 접근의 특징 → 치료 전 고려사항',
  ],
};

// 앵글/관점 변형
const CONTENT_ANGLES = [
  '환자 여정 중심: 처음 증상을 발견한 시간부터 치료 완료까지의 과정을 이야기',
  '원인 심층 분석: 왜 이 질환이 발생하는지, 체질적/환경적 원인을 깊이 파고드는 관점',
  '생활 밀착형: 일상생활에서의 관리법과 실천 팁 중심으로 한 실용적 관점',
  '한의학 원리: 한의학적 이론(기혈, 음양, 오장육부)에서 질환을 해석하는 전문적 관점',
  '비교 분석: 다양한 치료 옵션의 특징과 한방 치료의 차별점을 안내하는 관점',
  '계절/연령 맞춤: 특정 계절이나 연령대에 따른 증상 차이와 관리법을 이야기',
];

// 유틸: 배열에서 랜덤 선택
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── 레퍼런스 콘텐츠 로딩 시스템 ───
function loadReferenceContent() {
  const refDir = join(process.cwd(), 'data', 'reference');
  if (!existsSync(refDir)) return '';

  try {
    const files = readdirSync(refDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) return '';

    const shuffled = [...files].sort(() => Math.random() - 0.5);
    const sampleCount = Math.min(2 + Math.floor(Math.random() * 2), shuffled.length);
    const samples = shuffled.slice(0, sampleCount).map(f => {
      const content = readFileSync(join(refDir, f), 'utf-8');
      return content.substring(0, 2500);
    });

    return `
[레퍼런스 콘텐츠 - 아래 샘플들의 톤과 품질 수준을 참고하되, 구조와 표현은 자유롭게 변형을 주세요]
${samples.map((s, i) => `--- 샘플 ${i + 1} ---\n${s}`).join('\n\n')}
--- 레퍼런스 끝 ---

[참고 포인트]
- 위 샘플의 전문적 품질과 신뢰감 있는 톤을 유지하되, 구조와 흐름은 매번 다르게 구성하세요
- 브랜드명(화접몽한의원)은 자연스럽게 2-3회만 언급
- 과장 없는 담백하고 신뢰감 있는 어조
- 가짜 학술 인용 절대 금지
`;
  } catch (e) {
    console.error('레퍼런스 로딩 실패:', e.message);
    return '';
  }
}

// ─── 의료법 준수 규칙 ───
const MEDICAL_LAW_RULES = `
[의료법 제56조·제57조 준수 - 반드시 지켜야 할 규칙]
1. 치료 효과 보장 금지: "완치", "100% 효과", "확실한 치료" 등 단정적 효과 표현 사용 금지
2. 비교 광고 금지: 타 의료기관, 양방 치료와 직접 비교하거나 우수를 주장하는 표현 금지
3. 전후 사진 금지: 치료 전후 사진이나 구체적 수치 비교 금지
4. 환자 유인 금지: 무료 상담, 할인, 이벤트 등으로 유인하는 표현 금지
5. 과대 광고 금지: "최고", "최초", "유일" 등 객관적 근거 없는 최상급 표현 금지
6. 학술 인용 금지: 존재하지 않는 논문, 학술지, 연구 결과를 인용하지 마세요
7. 의료 면책 표현 필수: 글 마무리에 "개인별 체질과 증상에 따라 치료 결과가 다를 수 있습니다." 포함
8. 완화된 표현 사용: "~에 도움이 됩니다", "~을 기대할 수 있습니다", "~개선에 효과적입니다" 등 완화된 표현 사용
`;

// ─── GEO 최적화 규칙 ───
const GEO_OPTIMIZATION_RULES = `
[GEO(Generative Engine Optimization) 최적화 규칙]
1. 정의문 패턴: 각 섹션 시작에서 "~은(는) ~입니다" 형태의 명확한 정의문으로 시작하세요. AI가 정의문을 우선 인용합니다.
2. Q&A 패턴: 환자가 AI에게 물어볼 법한 질문을 H2/H3 소제목에 포함하세요.
3. 구조화된 정보: 원인, 증상, 치료법을 명확히 구분하여 AI가 파싱하기 쉽게 구조화하세요.
4. 단정적 어조: "~입니다", "~합니다" 형태의 확신적 어체를 사용하세요. AI는 확신적 정보를 우선 인용합니다.
5. 핵심 정보 선행: 각 단락의 첫 문장에 핵심 정보를 배치하세요 (역피라미드 구조).
6. 엔티티 명시: 질환명, 치료법명, 약재명을 정확히 명시하여 AI 엔티티 매칭을 유도하세요.
7. 사실/통계 활용: 구체적 숫자(치료 기간, 발생 빈도 등)를 포함하되, 출처가 불분명한 통계는 사용하지 마세요.
`;

// ─── 치료법 매핑 (질환별 화접몽 고유 치료법) ───
const TREATMENT_MAP = {
  'flat-warts': { name: '한방 사마귀 치료', desc: '화접몽한의원의 한방 치료로 편평사마귀 병변을 피부 손상 최소화하며 제거하고 재발을 방지하는 치료법' },
  'keratosis-pilaris': { name: '한방 모공각화증 치료', desc: '한약 치료와 외용 관리를 병행하여 각질 정상화를 유도하고 피부결을 개선하는 치료법' },
  'acne': { name: '한방 여드름 치료', desc: '한약 처방과 외용 치료를 병행하여 피지 조절, 염증 완화, 피부 재생을 돕는 한방 치료법' },
  'acne-scars': { name: '한방 여드름흉터 치료', desc: '한약 치료와 외용 관리를 통해 피부 재생을 유도하고 흉터를 완화하는 한방 치료법' },
  'folliculitis': { name: '한방 모낭염 치료', desc: '한약 치료와 외용제를 병행하여 모낭 염증을 완화하고 피부 장벽을 회복하는 치료법' },
  'atopic-dermatitis': { name: '한방 아토피 치료', desc: '체질 진단을 기반으로 한약 처방과 외용제 치료를 병행하여 면역 균형을 회복하는 치료법' },
  'psoriasis': { name: '한방 건선 치료', desc: '한약 치료를 통해 면역 균형을 조절하고 피부 염증을 완화하여 재발을 줄이는 치료법' },
  'dyshidrosis': { name: '한방 습진/한포진 치료', desc: '체질에 맞는 한약 처방으로 체내 습열을 제거하고 피부 장벽을 회복하는 치료법' },
  'diet': { name: '감비환 다이어트', desc: '화접몽한의원의 체질 맞춤 한약 처방과 식이 관리를 병행하는 한방 체중 관리 프로그램' },
  'seborrheic-dermatitis': { name: '한방 지루성피부염 치료', desc: '한약 치료로 체내 열과 습을 조절하고 외용제로 피부 염증을 완화하는 치료법' },
};

// ─── Google Gemini API 호출 헬퍼 ───
async function callGemini(apiKey, systemPrompt, userPrompt, options = {}) {
  const FALLBACK_MODELS = [AI_CONFIG.model, 'gemini-2.0-flash'];
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 30000];

  for (const model of FALLBACK_MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const url = `${AI_CONFIG.apiBase}/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: options.temperature || 0.4,
              maxOutputTokens: options.maxTokens || AI_CONFIG.maxTokens,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error('Gemini: 응답에서 텍스트를 찾을 수 없습니다');
          if (model !== AI_CONFIG.model) console.log(`[Gemini] fallback model used: ${model}`);
          return text;
        }

        if (response.status === 503 || response.status === 429) {
          const delay = RETRY_DELAYS[attempt] || 30000;
          console.log(`[Gemini] ${response.status} error (model: ${model}, attempt ${attempt + 1}/${MAX_RETRIES}) - retry in ${delay/1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const errText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errText}`);
      } catch (err) {
        if (attempt < MAX_RETRIES - 1 && !err.message.includes('Gemini API error:')) {
          const delay = RETRY_DELAYS[attempt] || 30000;
          console.log(`[Gemini] network error (attempt ${attempt + 1}) - retry in ${delay/1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (attempt === MAX_RETRIES - 1) {
          console.log(`[Gemini] model ${model} failed, trying next model...`);
          break;
        }
        throw err;
      }
    }
  }
  throw new Error('Gemini API: all models and retries exhausted');
}

// ─── Stage 1: 리서치 AI ───
async function stageResearch(apiKey, topic, contentType) {
  const angle = pickRandom(CONTENT_ANGLES);

  const systemPrompt = `당신은 한의학 및 피부질환 전문 리서치 어시스턴트입니다.
환자들이 실제로 검색하고 AI에게 질문하는 패턴을 분석하는 전문가입니다.
반드시 JSON 형식으로만 응답하세요.`;

  const userPrompt = `다음 질환에 대해 GEO(Generative Engine Optimization) 콘텐츠 리서치를 수행하세요.

질환: ${topic.name} (${topic.nameEn})
콘텐츠 유형: ${contentType.name}
기존 키워드: ${topic.keywords.join(', ')}

[이번 콘텐츠의 관점/앵글]
${angle}
→ 이 관점에 맞는 질문과 키워드를 중점적으로 리서치하세요.

다음을 분석하여 JSON으로 응답하세요:
{
  "patientQuestions": ["환자들이 AI에게 물어볼 법한 자연어 질문 7개 (위 관점 반영)"],
  "searchKeywords": ["관련 검색 패턴 10개 (롱테일 포함, 위 관점 반영)"],
  "competitorAngles": ["경쟁 콘텐츠에서 자주 다루는 앵글 5개"],
  "uniqueAngle": "이번 콘텐츠만의 차별화 포인트 (위 관점 + 화접몽 한방 전문성 결합)",
  "relatedConditions": ["연관 질환 3개 (내부 링크용)"],
  "suggestedAngle": "${angle}"
}

중요: medicalFacts나 연구 인용을 포함하지 마세요. 출처가 불분명한 통계나 논문명을 절대 생성하지 마세요.`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.6,
  });

  return JSON.parse(result);
}

// ─── Stage 2: 전략 AI ───
async function stageStrategy(apiKey, topic, contentType, research, existingTitles = []) {
  const structures = STRUCTURE_TEMPLATES[contentType.id] || STRUCTURE_TEMPLATES['comprehensive-guide'];
  const selectedStructure = pickRandom(structures);
  const isFaqType = contentType.id === 'faq';

  const systemPrompt = `당신은 GEO(Generative Engine Optimization) 전문 콘텐츠 전략가입니다.
AI가 답변에서 특정 브랜드를 인용하도록 유도하는 콘텐츠 구조를 설계합니다.
매번 새롭고 다양한 구조의 콘텐츠를 기획하는 것이 중요합니다.
반드시 JSON 형식으로만 응답하세요.`;

  const isCaseStudy = contentType.id === 'case-study';
  const caseStudyNote = isCaseStudy
    ? `\n[치료 사례 콘텐츠 주의사항]
- 실제 환자 사례가 아닌 "일반적인 치료 경과 설명" 형태로 구성하세요
- 특정 환자의 개인정보(나이, 성별, 직업 등)를 포함하지 마세요
- 치료 전후 비교, 구체적 수치 비교를 포함하지 마세요
- "~한 경우가 많습니다", "~하는 경향이 있습니다" 등 일반화된 표현을 사용하세요`
    : '';

  const faqField = isFaqType
    ? `\n  "faqQuestions": ["FAQ로 다룰 질문 7-10개 (리서치의 환자 질문 반영)"],`
    : '';

  const userPrompt = `리서치 데이터를 기반으로 GEO 최적화 콘텐츠 전략을 수립하세요.

브랜드: ${BRAND.name}
질환: ${topic.name}
콘텐츠 유형: ${contentType.name}
${caseStudyNote}

[콘텐츠 구조 가이드]
이번 콘텐츠는 다음 흐름으로 구성하세요: ${selectedStructure}
→ 이 구조에 맞게 outline의 heading과 keyPoints를 설계하세요.

리서치 데이터:
${JSON.stringify(research, null, 2)}

다음 전략을 JSON으로 응답하세요:
{
  "title": "제목을 여기에 작성",
  "metaDescription": "메타 설명을 여기에 작성",
  "slug": "seo-friendly-url-slug",
  "targetQuestion": "이 콘텐츠가 답변하는 핵심 질문",
  "outline": [
    {
      "heading": "H2 소제목을 여기에 작성",
      "keyPoints": ["다룰 핵심 포인트 3개"]
    }
  ],${faqField}
  "internalLinks": ["관련 콘텐츠 슬러그 3개"],
  "tags": ["WordPress 태그 5-8개"]
}

[제목 작성 규칙 - 매우 중요]
- 40자 이내로 작성하세요
- 질환명과 핵심 키워드를 포함하세요
- 괄호()를 사용하지 마세요. 제목에 괄호가 포함되면 안 됩니다.
- 쉼표, 콜론, 물음표 등으로 구분하세요
- 매번 다른 제목 형식을 사용하세요
- "~란? 원인·증상·치료법 완벽 가이드" 같은 기존 패턴을 반복하지 마세요
- "최고", "유일", "완치" 등 의료법 위반 표현 금지
${existingTitles.length > 0 ? `
[기존 콘텐츠와 차별화 - 매우 중요]
다음 제목의 콘텐츠가 이미 존재합니다. 반드시 다른 관점, 구조, 제목으로 작성하세요:
${existingTitles.map(t => `- "${t}"`).join('\n')}
` : ''}
[소제목 작성 규칙]
- 매번 다른 패턴(질문형, 정보 요약형, 핵심 키워드형 등)을 혼용하세요
- ${topic.name} 토픽에 깊이 집중하는 내용으로 구성하세요`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.7,
  });

  return JSON.parse(result);
}

// ─── Stage 3: 프로덕션 AI (핵심) ───
async function stageProduction(apiKey, topic, contentType, strategy) {
  const referenceContent = loadReferenceContent();
  const treatment = TREATMENT_MAP[topic.id] || { name: '한방 맞춤 치료', desc: '체질 진단 기반 맞춤형 한방 치료' };
  const writingStyle = pickRandom(WRITING_STYLES);
  const introStyle = pickRandom(INTRO_STYLES);
  const wordCount = 1200 + Math.floor(Math.random() * 600);
  const isFaqType = contentType.id === 'faq';

  const caseStudySafety = contentType.id === 'case-study' ? `
[치료 사례 콘텐츠 안전 규칙 - 의료법 필수 준수]
- 이것은 실제 환자 사례가 아닌 "일반적인 치료 경과 설명"입니다
- 특정 환자 정보(나이, 성별, 이름, 직업) 절대 포함 금지
- 치료 전후 사진 비교, 구체적 수치(면적, 개수 등) 비교 금지
- "완치되었다", "깨끗해졌다" 등 단정적 효과 표현 금지
- 대신 "~에 도움이 될 수 있습니다", "~개선을 기대할 수 있습니다" 사용
- 전체 글 톤: 일반적인 치료 경과와 관리 방법을 안내하는 교육적 콘텐츠
` : '';

  const faqInstruction = isFaqType
    ? `- FAQ는 최소 7개, 각 답변은 100자 이상으로 작성하세요
- 환자가 실제로 궁금해하는 질문 위주로 구성하세요`
    : `- faq 필드는 빈 배열 []로 설정하세요. FAQ 콘텐츠 타입이 아니므로 FAQ를 생성하지 마세요.
- 대신 본문 content에 ${topic.name}에 대한 깊이 있는 정보를 충실히 담으세요.`;

  const systemPrompt = `당신은 ${BRAND.name}의 전문 의료 콘텐츠 작성자입니다.
피부질환 한방 치료에 대한 깊은 전문 지식을 보유하고 있습니다.

[브랜드 정보]
- 이름: ${BRAND.name}
- 전문: ${BRAND.specialty}
- 웹사이트: ${BRAND.url}
- 이 질환에 대한 치료법: ${treatment.name} - ${treatment.desc}

${MEDICAL_LAW_RULES}

${GEO_OPTIMIZATION_RULES}

[이번 콘텐츠의 글쓰기 스타일]
${writingStyle.desc}

[도입부 스타일]
${introStyle}

[작성 규칙 - 반드시 준수]
1. 브랜드 톤: 위 글쓰기 스타일을 따르되, 전문성과 신뢰감을 유지
2. 절대 금지: 클릭베이트 표현 (충격, 놀라운, 폭발, 경악 등), 과장된 치료 효과 주장, 비공학적 근거 없는 주장
3. 브랜드 언급: "${BRAND.name}" 브랜드명을 본문에서 2-3회만 자연스럽게 삽입 (과도한 반복 금지)
4. 문체: 기본적으로 단정적 어체이되, 위 스타일에 따라 자연스럽게 변형 가능
5. 출처: 학술 논문/학술지/연구 인용 절대 금지. 일반적인 의학 상식만 활용하세요.
6. 구조: 전략(outline)에 정의된 구조를 따르세요 (매번 다른 섹션 구조)
7. 분량: 약 ${wordCount}자 내외
8. 전문 용어: 한의학 용어와 일반인이 이해하기 쉬운 설명을 병기
9. 글 마무리: "개인별 체질과 증상에 따라 치료 결과가 다를 수 있습니다." 면책 문구 필수 포함
10. 다양성: 이전에 작성한 콘텐츠와 다른 표현, 비유, 예시를 사용하세요. 같은 문장 패턴을 반복하지 마세요.
11. 토픽 집중: ${topic.name}에 대한 심도 있는 정보를 중심으로 작성하세요. 피상적이거나 일반적인 내용 나열을 피하세요.
${caseStudySafety}

반드시 JSON 형식으로만 응답하세요.

${referenceContent}`;

  const faqJsonField = isFaqType
    ? `"faq": [
    {"question": "질문", "answer": "100자 이상의 상세한 답변 (의료법 준수)"}
  ],`
    : `"faq": [],`;

  const userPrompt = `다음 전략에 따라 GEO 최적화 콘텐츠를 작성하세요.

질환: ${topic.name} (${topic.nameEn}, ${topic.medicalName})
콘텐츠 유형: ${contentType.name}
대표 치료법: ${treatment.name}

전략:
${JSON.stringify(strategy, null, 2)}

다음 JSON 형식으로 작성된 콘텐츠를 출력하세요:
{
  "title": "${strategy.title}",
  "metaDescription": "${strategy.metaDescription}",
  "slug": "${strategy.slug}",
  "excerpt": "요약을 여기에 작성 (100자 이내)",
  "content": "작성된 HTML 본문 (전략 outline 구조에 따라, <h2>, <h3>, <p>, <ul> 사용, 약 ${wordCount}자)",
  ${faqJsonField}
  "tags": ${JSON.stringify(strategy.tags)},
  "category": "${topic.category}"
}

[중요 - 반드시 지켜주세요]
- title에 괄호()를 절대 포함하지 마세요. 괄호가 포함된 제목은 거부됩니다.
- HTML content 내에서 "${BRAND.name}"을 2-3회만 자연스럽게 언급하세요 (과도한 반복 금지)
- 도입부는 "${introStyle}" 스타일로 시작하세요
- 이후 섹션은 정의문, 질문형, 스토리형 등 다양한 시작 패턴을 혼용하세요
${faqInstruction}
- 학술 논문명, 학술지명, 연구 결과를 절대 인용하지 마세요
- "완치", "100%", "최고", "유일" 등 의료법 위반 표현 사용 금지
- 글 마지막에 반드시 의료 면책 문구를 포함하세요
- references 필드는 포함하지 마세요 (가짜 인용 방지)
- ${topic.name} 토픽에 깊이 집중하세요: 원인, 증상, 치료, 관리법 등을 구체적이고 실질적으로 다루세요
- 기존 콘텐츠와 차별화: 새로운 비유, 예시, 표현을 적극 활용하세요`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    maxTokens: 8192,
    temperature: 0.85,
  });

  return JSON.parse(result);
}

// ─── Pexels 검색어 다양화 (질환별 쿼리 풀) ───
const PEXELS_QUERY_POOLS = {
  'flat-warts': ['dermatology treatment', 'skin clinic consultation', 'hand skin close up', 'korean herbal medicine', 'acupuncture therapy', 'skin examination doctor', 'natural skin remedy'],
  'plantar-warts': ['foot care treatment', 'podiatry clinic', 'walking barefoot healthy', 'foot massage therapy', 'herbal foot soak', 'acupuncture foot treatment', 'foot skin health'],
  'genital-warts': ['medical consultation clinic', 'immune system health', 'herbal medicine preparation', 'doctor patient trust', 'traditional medicine clinic', 'wellness lifestyle healthy', 'medical privacy care'],
  'warts-treatment': ['skin treatment dermatology', 'herbal cream remedy', 'oriental medicine herbs', 'acupuncture session', 'healthy skin glow', 'medical treatment progress', 'natural healing process'],
  'atopic-dermatitis': ['sensitive skin care', 'moisturizer application', 'herbal bath therapy', 'eczema treatment natural', 'skin barrier repair', 'allergy free lifestyle', 'gentle skincare routine'],
  'acne-treatment': ['clear skin facial', 'acne skincare routine', 'herbal face mask', 'skin detox treatment', 'teenage skincare healthy', 'facial treatment spa', 'clean beauty natural'],
  'urticaria': ['allergy relief treatment', 'immune health wellness', 'stress relief relaxation', 'herbal tea remedy', 'antihistamine natural', 'skin rash treatment', 'calming lifestyle wellness'],
  'psoriasis': ['chronic skin condition', 'scalp treatment care', 'moisturizing therapy skin', 'autoimmune health wellness', 'herbal medicine oriental', 'skin renewal treatment', 'holistic health approach'],
  'hair-loss': ['healthy hair growth', 'scalp massage therapy', 'hair treatment clinic', 'herbal hair remedy', 'hair care natural', 'trichology consultation', 'hair restoration treatment'],
  'seborrheic-dermatitis': ['scalp care shampoo', 'sebum control treatment', 'dandruff remedy natural', 'scalp health examination', 'gentle cleansing routine', 'herbal scalp treatment', 'skin microbiome balance'],
};

const PEXELS_GENERAL_POOL = [
  'korean traditional medicine', 'herbal medicine clinic', 'acupuncture treatment session',
  'wellness health lifestyle', 'doctor consultation friendly', 'oriental medicine herbs',
  'patient care clinic', 'holistic health approach', 'oriental medicine herbs', 'therapeutic massage treatment',
  'healthy living nature', 'medical professional care', 'natural healing herbs',
];

function diversifyPexelsQuery(baseQuery, topicId) {
  const pool = PEXELS_QUERY_POOLS[topicId] || PEXELS_GENERAL_POOL;
  // 70% 확률로 질환별 풀에서 랜덤 선택, 30%로 일반 풀
  if (Math.random() < 0.7) {
    return pickRandom(pool);
  }
  return pickRandom(PEXELS_GENERAL_POOL);
}

// ─── 이미지 가져오기 (Pexels) ───
async function fetchPexelsImages(apiKey, query, count = 3) {
  if (!apiKey) return [];

  try {
    // 랜덤 페이지로 매번 다른 이미지 세트 가져오기
    const randomPage = Math.floor(Math.random() * 5) + 1;
    const response = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&page=${randomPage}&orientation=landscape`,
      { headers: { Authorization: apiKey } }
    );

    if (!response.ok) return [];

    const data = await response.json();
    return data.photos.map((photo) => ({
      url: photo.src.large,
      alt: photo.alt || query,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      pexelsUrl: photo.url,
    }));
  } catch (error) {
    console.error('Pexels API error:', error);
    return [];
  }
}

// ─── 이미지 alt 텍스트 SEO 최적화 ───
function optimizeImageAlt(originalAlt, topic, index) {
  const altTemplates = [
    `${topic.name} 한방 치료 관련 이미지 - ${BRAND.name}`,
    `${topic.name} 증상과 관리 방법 안내`,
    `${topic.name} 치료를 위한 한의학적 접근`,
  ];
  return altTemplates[index] || `${topic.name} 관련 피부 건강 이미지`;
}

// ─── 이미지를 HTML에 삽입 ───
function insertInlineImages(html, images, topic) {
  if (!images || images.length === 0) return html;

  const h2Tags = html.match(/<\/h2>/gi);
  if (!h2Tags || h2Tags.length < 2) return html;

  let insertCount = 0;
  let imageIndex = 0;
  return html.replace(/<\/h2>/gi, (match) => {
    insertCount++;
    if ((insertCount === 2 || insertCount === 4) && images[imageIndex]) {
      const img = images[imageIndex];
      const altText = optimizeImageAlt(img.alt, topic, imageIndex);
      imageIndex++;
      const imgHtml = `</h2>
<figure class="wp-block-image">
  <img src="${img.url}" alt="${altText}" loading="lazy" />
  <figcaption>사진: <a href="${img.photographerUrl}" target="_blank">${img.photographer}</a> / <a href="${img.pexelsUrl}" target="_blank">Pexels</a></figcaption>
</figure>`;
      return imgHtml;
    }
    return match;
  });
}

// ─── FAQ HTML 생성 ───
function generateFaqHtml(faq) {
  if (!faq || faq.length === 0) return '';

  let html = '<h2>자주 묻는 질문</h2>\n<div class="faq-section">\n';
  for (const item of faq) {
    html += `  <div class="faq-item">
    <h3>${item.question}</h3>
    <p>${item.answer}</p>
  </div>\n`;
  }
  html += '</div>';
  return html;
}

// ─── 브랜드 CTA 섹션 생성 ───
function generateBrandCta(topic) {
  const treatment = TREATMENT_MAP[topic.id] || { name: '한방 맞춤 치료' };
  return `
<div class="brand-cta" style="background:#f8f9fa; border-left:4px solid #2E75B6; padding:20px; margin:30px 0;">
  <h3>${BRAND.name} - ${topic.name} ${treatment.name}</h3>
  <p>${BRAND.name}에서는 ${topic.name} 치료를 위해 개인별 체질과 증상을 정밀하게 분석한 후 맞춤형 치료를 진행합니다.</p>
  <p><strong>화접몽 홈페이지 바로가기:</strong> <a href="https://www.mongclinic.com/" target="_blank">https://www.mongclinic.com/</a></p>
</div>`;
}

// ─── 의료 면책 조항 HTML ───
function generateMedicalDisclaimer() {
  return `
<div class="medical-disclaimer" style="background:#fff3cd; border:1px solid #ffc107; border-radius:8px; padding:15px; margin:30px 0; font-size:0.9em; color:#664d03;">
  <p><strong>※ 의료법에 따른 안내</strong></p>
  <p>본 콘텐츠는 건강 정보 제공을 목적으로 작성되었으며, 의학적 진단이나 치료를 대체하지 않습니다.
  개인별 체질과 증상에 따라 치료 결과가 다를 수 있으므로, 정확한 진단과 치료를 위해 반드시 전문 의료진과 상담하시기 바랍니다.</p>
</div>`;
}

// ─── GEO 최적화 점수 계산 ───
function calculateGeoScore(content, title, metaDescription, faq, schemas) {
  const details = {};
  let total = 0;

  // 1. FAQ 포함 여부 (15점)
  const hasFaq = faq && faq.length > 0;
  details.faq = { score: hasFaq ? 15 : 0, max: 15, label: 'FAQ 포함' };
  total += details.faq.score;

  // 2. JSON-LD 스키마 (15점)
  const hasSchema = schemas && Object.keys(schemas).length > 0;
  details.schema = { score: hasSchema ? 15 : 0, max: 15, label: 'JSON-LD 스키마' };
  total += details.schema.score;

  // 3. 메타 디스크립션 (10점)
  const metaLen = (metaDescription || '').length;
  const metaScore = metaLen >= 80 && metaLen <= 160 ? 10 : metaLen > 0 ? 5 : 0;
  details.meta = { score: metaScore, max: 10, label: '메타 디스크립션' };
  total += metaScore;

  // 4. 구조화된 헤딩 (15점) - h2, h3 태그 사용
  const h2Count = (content.match(/<h2/g) || []).length;
  const h3Count = (content.match(/<h3/g) || []).length;
  const headingScore = h2Count >= 3 && h3Count >= 2 ? 15 : h2Count >= 2 ? 10 : h2Count >= 1 ? 5 : 0;
  details.headings = { score: headingScore, max: 15, label: '구조화된 헤딩', h2: h2Count, h3: h3Count };
  total += headingScore;

  // 5. 콘텐츠 길이 (15점) - 1500자 이상
  const textOnly = content.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const lenScore = textOnly.length >= 2000 ? 15 : textOnly.length >= 1500 ? 12 : textOnly.length >= 1000 ? 8 : 3;
  details.length = { score: lenScore, max: 15, label: '콘텐츠 길이', chars: textOnly.length };
  total += lenScore;

  // 6. 키워드 밀도 (15점) - 제목 핵심 키워드가 본문에 적절히 등장
  const titleKeywords = title.replace(/[^가-힣a-zA-Z\s]/g, '').split(/\s+/).filter(k => k.length >= 2);
  let keywordHits = 0;
  for (const kw of titleKeywords) {
    const regex = new RegExp(kw, 'gi');
    const count = (content.match(regex) || []).length;
    if (count >= 2) keywordHits++;
  }
  const kwScore = titleKeywords.length > 0 ? Math.min(15, Math.round((keywordHits / titleKeywords.length) * 15)) : 7;
  details.keywords = { score: kwScore, max: 15, label: '키워드 밀도' };
  total += kwScore;

  // 7. 통계/숫자 포함 (15점)
  const statsPattern = /\d+(%|명|건|배|세|년|개월|주|일|시간|cm|mg|ml)/g;
  const statsCount = (content.match(statsPattern) || []).length;
  const statsScore = statsCount >= 5 ? 15 : statsCount >= 3 ? 10 : statsCount >= 1 ? 5 : 0;
  details.stats = { score: statsScore, max: 15, label: '통계/숫자 데이터', count: statsCount };
  total += statsScore;

  return { score: total, max: 100, details };
}

// ─── E-E-A-T 점수 계산 ───
function calculateEeatScore(content, title) {
  const details = {};
  let total = 0;

  // 1. Experience - 치료 사례/경험 언급 (25점)
  const expPatterns = [/치료\s*사례/g, /임상/g, /진료\s*경험/g, /환자/g, /치료\s*경과/g, /치료\s*후/g, /치료\s*과정/g, /치료\s*결과/g];
  let expHits = 0;
  for (const p of expPatterns) { expHits += (content.match(p) || []).length; }
  const expScore = expHits >= 5 ? 25 : expHits >= 3 ? 20 : expHits >= 1 ? 12 : 0;
  details.experience = { score: expScore, max: 25, label: 'Experience (경험)', hits: expHits };
  total += expScore;

  // 2. Expertise - 의학 용어 정확성 (25점)
  const medTerms = [/한약/g, /처방/g, /체질/g, /변증/g, /면역/g, /염증/g, /피지/g, /각질/g, /장벽/g, /재생/g, /진단/g, /증상/g, /병변/g, /외용/g, /한의학/g];
  let termHits = 0;
  for (const p of medTerms) { termHits += (content.match(p) || []).length; }
  const exprtScore = termHits >= 10 ? 25 : termHits >= 6 ? 20 : termHits >= 3 ? 12 : 3;
  details.expertise = { score: exprtScore, max: 25, label: 'Expertise (전문성)', hits: termHits };
  total += exprtScore;

  // 3. Authoritativeness - 브랜드 CTA / 의료기관 정보 (25점)
  const hasClinicName = /화접몽/g.test(content);
  const hasHomepage = /mongclinic\.com/g.test(content);
  const hasCta = /<div class="brand-cta"/.test(content);
  const authScore = (hasClinicName ? 10 : 0) + (hasHomepage ? 8 : 0) + (hasCta ? 7 : 0);
  details.authoritativeness = { score: authScore, max: 25, label: 'Authoritativeness (권위성)', clinicName: hasClinicName, homepage: hasHomepage, cta: hasCta };
  total += authScore;

  // 4. Trustworthiness - 면책조항 + 과장 표현 부재 (25점)
  const hasDisclaimer = /의료법에 따른 안내/.test(content) || /의학적 진단이나 치료를 대체/.test(content);
  const exaggerations = [/완치/g, /100%/g, /기적/g, /최고의/g, /완벽/g];
  let exagCount = 0;
  for (const p of exaggerations) { exagCount += (content.match(p) || []).length; }
  const trustScore = (hasDisclaimer ? 15 : 0) + (exagCount === 0 ? 10 : exagCount <= 2 ? 5 : 0);
  details.trustworthiness = { score: trustScore, max: 25, label: 'Trustworthiness (신뢰성)', disclaimer: hasDisclaimer, exaggerations: exagCount };
  total += trustScore;

  return { score: total, max: 100, details };
}

// ─── AI 콘텐츠 자동 검수 시스템 ───
const REVIEW_RULES = {
  // 의료법 56조 위반 표현 (절대 금지)
  medical: [
    { pattern: /완치/g, replacement: '개선', category: '의료법', severity: 'high' },
    { pattern: /100%\s*(효과|치료|개선|완치|치유)/g, replacement: '효과적인 $1', category: '의료법', severity: 'high' },
    { pattern: /확실한\s*(치료|효과|완치)/g, replacement: '체계적인 $1', category: '의료법', severity: 'high' },
    { pattern: /최고의\s*(치료|효과|결과|병원|한의원)/g, replacement: '전문적인 $1', category: '의료법', severity: 'high' },
    { pattern: /유일한\s*(치료|방법|해결책)/g, replacement: '효과적인 $1', category: '의료법', severity: 'high' },
    { pattern: /기적(적인|의|)/g, replacement: '긍정적$1', category: '의료법', severity: 'high' },
    { pattern: /완벽(한|하게|히)\s*(치료|제거|해결)/g, replacement: '효과적$1 $2', category: '의료법', severity: 'high' },
    { pattern: /반드시\s*(낫|치료|완치|호전)/g, replacement: '충분히 $1', category: '의료법', severity: 'high' },
    { pattern: /무조건/g, replacement: '대체로', category: '의료법', severity: 'high' },
    { pattern: /부작용\s*(이\s*)?없/g, replacement: '부작용이 적', category: '의료법', severity: 'high' },
    { pattern: /안전\s*(이\s*)?(100|완벽|확실)/g, replacement: '안전성이 높', category: '의료법', severity: 'high' },
  ],
  // 과장 광고 표현
  exaggeration: [
    { pattern: /획기적인/g, replacement: '전문적인', category: '과장광고', severity: 'medium' },
    { pattern: /놀라운\s*(효과|결과|변화)/g, replacement: '긍정적인 $1', category: '과장광고', severity: 'medium' },
    { pattern: /압도적(인|으로)/g, replacement: '뛰어난', category: '과장광고', severity: 'medium' },
    { pattern: /독보적(인|으로)/g, replacement: '전문적', category: '과장광고', severity: 'medium' },
    { pattern: /경이로운/g, replacement: '주목할 만한', category: '과장광고', severity: 'medium' },
    { pattern: /즉각적(인|으로)?\s*(효과|개선|변화)/g, replacement: '빠른 $2', category: '과장광고', severity: 'medium' },
    { pattern: /단\s*\d+\s*(일|회|번)\s*(만에|으로)/g, replacement: '꾸준한 관리를 통해', category: '과장광고', severity: 'medium' },
    { pattern: /마법(같은|의|처럼)/g, replacement: '효과적인', category: '과장광고', severity: 'medium' },
    { pattern: /혁신적(인|으로)/g, replacement: '체계적', category: '과장광고', severity: 'medium' },
    { pattern: /세계\s*(최초|유일|최고)/g, replacement: '전문', category: '과장광고', severity: 'medium' },
    { pattern: /국내\s*(최초|유일|최고)/g, replacement: '전문', category: '과장광고', severity: 'medium' },
  ],
};

function reviewContent(html, title) {
  const fixes = [];
  let processed = html;
  let processedTitle = title;

  // 본문 검수
  for (const category of Object.keys(REVIEW_RULES)) {
    for (const rule of REVIEW_RULES[category]) {
      const matches = processed.match(rule.pattern);
      if (matches) {
        fixes.push({
          category: rule.category,
          severity: rule.severity,
          found: matches[0],
          replacement: rule.replacement.replace(/\$\d/g, '...'),
          count: matches.length,
          location: 'content',
        });
        processed = processed.replace(rule.pattern, rule.replacement);
      }
    }
  }

  // 제목 검수
  for (const category of Object.keys(REVIEW_RULES)) {
    for (const rule of REVIEW_RULES[category]) {
      const matches = processedTitle.match(rule.pattern);
      if (matches) {
        fixes.push({
          category: rule.category,
          severity: rule.severity,
          found: matches[0],
          replacement: rule.replacement.replace(/\$\d/g, '...'),
          count: matches.length,
          location: 'title',
        });
        processedTitle = processedTitle.replace(rule.pattern, rule.replacement);
      }
    }
  }

  const highCount = fixes.filter(f => f.severity === 'high').length;
  const mediumCount = fixes.filter(f => f.severity === 'medium').length;

  return {
    passed: fixes.length === 0,
    content: processed,
    title: processedTitle,
    fixes,
    summary: {
      total: fixes.length,
      high: highCount,
      medium: mediumCount,
      status: fixes.length === 0 ? 'clean' : highCount > 0 ? 'fixed-critical' : 'fixed-minor',
    },
  };
}

// 기존 호환용 래퍼
function postProcessHtml(html) {
  return reviewContent(html, '').content;
}

// ─── 제목 후처리 (괄호 내용 제거) ───
function cleanTitle(title) {
  // 괄호와 그 안의 내용을 제거
  let cleaned = title.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // 중복 공백 제거
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned;
}

// ─── 가짜 인용 제거 ───
function removeFakeReferences(content) {
  if (content.references) {
    delete content.references;
  }
  if (content.content) {
    content.content = content.content.replace(/<h[23]>.*?참고문헌.*?<\/h[23]>[\s\S]*?(?=<h[23]>|$)/gi, '');
    content.content = content.content.replace(/<h[23]>.*?References.*?<\/h[23]>[\s\S]*?(?=<h[23]>|$)/gi, '');
  }
  return content;
}

// ─── 메인 생성 함수 (외부에서 호출) ───
export async function generateContent(env, topic, contentType, options = {}) {
  const geminiKey = env.GEMINI_API_KEY;
  const pexelsKey = env.PEXELS_API_KEY;
  const isFaqType = contentType.id === 'faq';

  if (!geminiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다');

  console.log(`[Stage 1] 리서치 시작: ${topic.name} - ${contentType.name}`);
  const research = await stageResearch(geminiKey, topic, contentType);

  console.log(`[Stage 2] 전략 수립: ${topic.name} - ${contentType.name}`);
  const strategy = await stageStrategy(geminiKey, topic, contentType, research, options.existingTitles || []);

  console.log(`[Stage 3] 콘텐츠 생성: ${topic.name} - ${contentType.name}`);
  const production = await stageProduction(geminiKey, topic, contentType, strategy);

  // 가짜 인용 제거
  const cleanedProduction = removeFakeReferences(production);

  // 제목 후처리 (괄호 제거)
  cleanedProduction.title = cleanTitle(cleanedProduction.title);

  // 이미지 가져오기 (검색어 다양화 적용)
  const diversifiedQuery = diversifyPexelsQuery(topic.pexelsQuery, topic.id);
  console.log(`[이미지] Pexels 이미지 가져오기: ${diversifiedQuery} (원본: ${topic.pexelsQuery})`);
  const images = await fetchPexelsImages(pexelsKey, diversifiedQuery, 3);

  // 콘텐츠 조립
  let finalContent = cleanedProduction.content;

  // AI 콘텐츠 자동 검수 (의료법 위반 + 과장 광고 체크 및 자동 치환)
  const reviewResult = reviewContent(finalContent, cleanedProduction.title);
  finalContent = reviewResult.content;
  cleanedProduction.title = reviewResult.title;
  if (reviewResult.fixes.length > 0) {
    console.log(`[검수] ${reviewResult.summary.total}건 치환 완료 (의료법: ${reviewResult.summary.high}, 과장광고: ${reviewResult.summary.medium})`);
    reviewResult.fixes.forEach(f => console.log(`  - [${f.category}] "${f.found}" → "${f.replacement}" (${f.location})`));
  } else {
    console.log('[검수] 위반 사항 없음 ✓');
  }

  // 인라인 이미지 삽입 (SEO 최적화된 alt 텍스트)
  finalContent = insertInlineImages(finalContent, images, topic);

  // FAQ 섹션: FAQ 콘텐츠 타입일 때만 추가
  if (isFaqType && cleanedProduction.faq && cleanedProduction.faq.length > 0) {
    finalContent += '\n' + generateFaqHtml(cleanedProduction.faq);
  }

  // 브랜드 CTA 추가
  finalContent += '\n' + generateBrandCta(topic);

  // 의료 면책 조항 추가
  finalContent += '\n' + generateMedicalDisclaimer();

  // JSON-LD 스키마 생성
  const schemas = generateSchemas(topic, cleanedProduction);

  // NOTE: WordPress.com 호스팅형은 <script> 태그를 자동 제거하므로
  // 본문에 JSON-LD를 삽입하지 않음. schemas 필드에 데이터 보존.

  // GEO / E-E-A-T 품질 점수 계산
  const geoResult = calculateGeoScore(finalContent, cleanedProduction.title, cleanedProduction.metaDescription, cleanedProduction.faq, schemas);
  const eeatResult = calculateEeatScore(finalContent, cleanedProduction.title);
  console.log(`[품질] GEO: ${geoResult.score}/100, E-E-A-T: ${eeatResult.score}/100`);

  return {
    title: cleanedProduction.title,
    slug: cleanedProduction.slug || strategy.slug,
    content: finalContent,
    excerpt: cleanedProduction.excerpt,
    metaDescription: cleanedProduction.metaDescription,
    tags: cleanedProduction.tags,
    category: cleanedProduction.category,
    faq: cleanedProduction.faq,
    heroImage: images[0] || null,
    schemas,
    review: reviewResult.summary,
    geoScore: geoResult,
    eeatScore: eeatResult,
    _meta: {
      topic: topic.id,
      contentType: contentType.id,
      comboId: `${topic.id}__${contentType.id}`,
      generatedAt: new Date().toISOString(),
      stages: { research, strategy },
    },
  };
}
