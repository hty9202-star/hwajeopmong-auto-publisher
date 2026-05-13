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
  { id: 'warm-expert', desc: '따뜻하고 전문적인 톤. 독자의 불안감을 덜어주는 편안한 블로그 글로 작성하세요.' },
  { id: 'educational', desc: '교육적이고 설명적인 톤. 어려운 의학 지식을 쉽게 풀어 설명하는 블로그 글로 작성하세요.' },
  { id: 'empathetic', desc: '공감형 톤. 독자가 겪는 고민과 불편함에 공감하며 해결책을 안내하는 블로그 글로 작성하세요.' },
  { id: 'practical', desc: '실용적이고 간결한 톤. 바로 실천할 수 있는 정보 위주로, 군더더기 없이 작성하세요.' },
  { id: 'storytelling', desc: '이야기형 톤. 일상적 상황에서 시작하여 자연스럽게 의학 정보로 연결하는 블로그 글로 작성하세요.' },
];

// 도입부 스타일 변형
const INTRO_STYLES = [
  '흔히 겪는 상황이나 고민을 서술형으로 시작하세요 (예: "거울을 볼 때마다 신경 쓰이는 잡티, 알고 보면 편평사마귀일 수 있습니다.")',
  '핵심 정의문으로 시작하세요 (예: "~은(는) ~에 의해 발생하는 피부 질환입니다.")',
  '흥미로운 의학적 사실로 시작하세요 (예: "피부 고민으로 병원을 찾는 분들 중 상당수가 이 질환을 갖고 있습니다.")',
  '계절이나 환경 변화에 연결하여 시작하세요 (예: "환절기가 되면 유독 심해지는 증상이 있습니다.")',
  '증상 묘사로 시작하세요 (예: "팔뚝이나 허벅지에 오돌토돌한 돌기가 잡힌다면 모공각화증을 의심할 수 있습니다.")',
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

// ─── 레퍼런스 콘텐츠 로딩 시스템 (토픽 매칭 우선) ───
function loadReferenceContent(topic) {
  const refDir = join(process.cwd(), 'data', 'reference');
  if (!existsSync(refDir)) return '';

  try {
    const files = readdirSync(refDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) return '';

    const sampleCount = Math.min(3 + Math.floor(Math.random() * 2), files.length);
    const selected = [];

    // 토픽명으로 관련 레퍼런스 우선 선택
    if (topic && topic.name) {
      const matched = files.filter(f => f.includes(topic.name));
      const shuffledMatched = [...matched].sort(() => Math.random() - 0.5);
      const matchCount = Math.min(2, shuffledMatched.length, sampleCount);
      selected.push(...shuffledMatched.slice(0, matchCount));
    }

    // 나머지는 다른 파일에서 랜덤 채우기
    const remaining = files.filter(f => !selected.includes(f));
    const shuffledRemaining = [...remaining].sort(() => Math.random() - 0.5);
    const fillCount = sampleCount - selected.length;
    selected.push(...shuffledRemaining.slice(0, fillCount));

    const samples = selected.map(f => {
      const content = readFileSync(join(refDir, f), 'utf-8');
      return content.substring(0, 4000);
    });

    return `
[레퍼런스 콘텐츠 - 아래 샘플들의 글쓰기 스타일을 반드시 따르세요. 이것이 우리 브랜드의 글 톤입니다.]
${samples.map((s, i) => `--- 샘플 ${i + 1} ---\n${s}`).join('\n\n')}
--- 레퍼런스 끝 ---

[레퍼런스 스타일 규칙 - 최우선으로 따를 것]
1. 문단 길이: 한 <p> 태그에 2~3문장만. 4줄 이상 이어지는 긴 문단은 절대 금지입니다.
2. 문장 호흡: 한 문장은 짧게(15~30자 내외). 복문보다 단문을 연결하세요.
3. 어미: "~합니다", "~입니다", "~있습니다", "~됩니다" 형태의 격식 서술체(~다 체)로 마무리하세요. "~거든요", "~인데요" 같은 ~요 체는 사용하지 마세요.
4. 문장 흐름: 문장과 문장 사이에 접속사("그래서", "다만", "특히", "실제로", "반면", "즉")를 자연스럽게 넣어 글의 흐름을 만드세요. "A입니다. B입니다. C입니다." 식의 단순 나열 금지. 어미도 "~합니다/~입니다/~됩니다/~있습니다/~좋습니다/~필요합니다" 등 다양하게 섞으세요.
5. 도입부: 증상 묘사나 상황 서술로 시작하세요. "~하신 적 있으신가요?" 같은 질문형 도입 금지. "진료실에서~" 같은 의사 1인칭 시점도 금지합니다.
5. 시점: 3인칭 블로그 글 시점으로 작성하세요. "저희 한의원에서는~", "진료실에서 많이 듣는~" 같은 의사/병원 화법 금지.
6. 전문성: 의학 정보를 쉬운 비유와 일상 언어로 풀어 설명하세요. 교과서식 나열 금지.
7. 브랜드 언급: 화접몽한의원은 글 중반~후반부에 치료 설명 흐름 속에서 2~3회만 자연스럽게 녹이세요.
8. 마무리: 부드럽게 내원을 권유하되 광고처럼 느껴지지 않게 작성하세요.
`;
  } catch (e) {
    console.error('레퍼런스 로딩 실패:', e.message);
    return '';
  }
}

// ─── 홈페이지 실시간 참조 시스템 ───
const HOMEPAGE_URLS = [
  'https://www.mongclinic.com/',
  'https://www.mongclinic.com/index.php/html/7',
  'https://www.mongclinic.com/index.php/html/9',
  'https://www.mongclinic.com/index.php/html/88',
  'https://www.mongclinic.com/index.php/html/120',
  'https://www.mongclinic.com/index.php/html/10',
  'https://www.mongclinic.com/index.php/html/122',
  'https://www.mongclinic.com/index.php/html/130',
  'https://www.mongclinic.com/index.php/html/13',
  'https://www.mongclinic.com/index.php/html/12',
  'https://www.mongclinic.com/index.php/html/14',
  'https://www.mongclinic.com/index.php/html/15',
  'https://www.mongclinic.com/index.php/html/16',
  'https://www.mongclinic.com/index.php/html/132',
  'https://www.mongclinic.com/index.php/html/133',
  'https://www.mongclinic.com/index.php/board/list/column/27',
];
const HOMEPAGE_CACHE = { data: null, fetchedAt: 0 };
const HOMEPAGE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6시간 캐시

async function fetchHomepageContent() {
  // 캐시가 유효하면 재사용
  if (HOMEPAGE_CACHE.data && (Date.now() - HOMEPAGE_CACHE.fetchedAt) < HOMEPAGE_CACHE_TTL) {
    return HOMEPAGE_CACHE.data;
  }

  const results = [];
  // 칼럼 게시판 개별 글 URL 수집
  const allUrls = [...HOMEPAGE_URLS];
  const columnListUrl = HOMEPAGE_URLS.find(u => u.includes('/board/list/column'));
  if (columnListUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const listRes = await fetch(columnListUrl, {
        headers: { 'User-Agent': 'HwajeopmongBot/1.0 (content-generator)' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (listRes.ok) {
        const listHtml = await listRes.text();
        // 칼럼 개별 글 링크 추출 (최근 5개)
        const linkMatches = [...listHtml.matchAll(/href=["'](\/index\.php\/board\/view\/column\/\d+\/\d+)["']/gi)];
        const columnUrls = linkMatches.slice(0, 5).map(m => `https://www.mongclinic.com${m[1]}`);
        allUrls.push(...columnUrls);
        console.log(`[홈페이지 크롤링] 칼럼 개별 글 ${columnUrls.length}건 추가`);
      }
    } catch (e) {
      console.log(`[홈페이지 크롤링] 칼럼 목록 파싱 실패: ${e.message}`);
    }
  }

  for (const url of allUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'HwajeopmongBot/1.0 (content-generator)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) continue;
      const html = await res.text();

      // 이미지 alt 텍스트 보존 후 태그 제거
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleaned.length > 100) {
        results.push(cleaned.substring(0, 1000));
      }
    } catch (e) {
      console.log(`[홈페이지 크롤링] ${url} 실패: ${e.message}`);
    }
  }

  if (results.length === 0) return '';

  const content = `
[홈페이지 실시간 참조 - 아래는 화접몽한의원 공식 홈페이지에서 가져온 최신 정보입니다]
${results.map((r, i) => `--- 페이지 ${i + 1} ---\n${r}`).join('\n\n')}
--- 홈페이지 참조 끝 ---

[홈페이지 참조 활용 지침]
- 홈페이지에 명시된 진료 과목, 치료법, 원장 소개, 질환 정보를 정확하게 반영하세요
- 홈페이지에 없는 치료법이나 서비스를 임의로 만들어내지 마세요
- 연락처, 위치, 진료시간 등 팩트 정보는 홈페이지 내용을 그대로 사용하세요
- 칼럼 게시판의 전문 콘텐츠를 참고하여 깊이 있는 정보를 반영하세요
- 홈페이지 문구를 그대로 복사하지 말고, 자연스럽게 재구성하세요
`;

  HOMEPAGE_CACHE.data = content;
  HOMEPAGE_CACHE.fetchedAt = Date.now();
  return content;
}

// ─── 서브토픽 정보 로딩 ───
function getSubtopicsInfo(currentTopic) {
  const subtopics = currentTopic.subtopics || [];
  if (subtopics.length === 0) return '';

  return `
[서브토픽 - 이 질환의 세부 주제들]
메인 토픽: ${currentTopic.name}
서브토픽: ${subtopics.join(', ')}

[서브토픽 활용 지침]
- 위 서브토픽들은 "${currentTopic.name}" 아래에 속하는 세부 주제입니다.
- 콘텐츠 작성 시 서브토픽 중 2~3개를 본문에서 자연스럽게 다루세요.
- 예시: "${currentTopic.name}" 글에서 "${subtopics[0]}", "${subtopics.length > 1 ? subtopics[1] : subtopics[0]}" 등을 소섹션이나 언급으로 포함
- 서브토픽 각각에 대해 간단한 설명(1~2문장)을 포함하되, 메인 토픽과의 연관성을 강조하세요.
- 서브토픽별 화접몽한의원의 치료 접근이 가능함을 자연스럽게 안내하세요.
- 내부 링크 연결 기회: 서브토픽 언급 시 별도 콘텐츠로 연결할 수 있도록 구조화하세요.
`;
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
2. 소제목(H2) 스타일: 공감형·질문형·핵심키워드형으로 작성하세요. AI가 자연어 질문을 매칭할 수 있어야 합니다.
   - 좋은 예: "편평사마귀, 잡티인 줄 알았는데 자꾸 번집니다", "왜 자꾸 재발하는 걸까요?", "한의원 치료는 어떻게 다를까요?"
   - 나쁜 예: "편평사마귀의 정의와 특징", "편평사마귀의 주요 원인", "치료 방법 및 예후"
   - 금지: "~의 정의", "~의 원인", "~의 특징", "~의 개요" 같은 백과사전식 소제목
3. 구조화된 정보: 원인, 증상, 치료법을 명확히 구분하여 AI가 파싱하기 쉽게 구조화하세요.
4. 단정적 어조: "~입니다", "~합니다" 형태의 확신적 어체를 사용하세요. AI는 확신적 정보를 우선 인용합니다.
5. 핵심 정보 선행: 각 단락의 첫 문장에 핵심 정보를 배치하세요 (역피라미드 구조).
6. 엔티티 명시: 질환명, 치료법명(화안케어, 거우침, 고밀도 AMTS, 감비환 등), 약재명을 정확히 명시하여 AI 엔티티 매칭을 유도하세요.
7. 사실 활용: 구체적 숫자(치료 기간, 발생 빈도 등)를 포함하되, 출처가 불분명한 통계는 사용하지 마세요.
`;

// ─── 치료법 매핑 (질환별 화접몽 고유 치료법) ───
const TREATMENT_MAP = {
  'flat-warts': { name: '거우침 치료 + 화안케어', desc: '화접몽한의원 고유 개발 한방 침 시술인 거우침으로 편평사마귀 병변을 피부 손상 최소화하며 제거하고, 화안케어(미세약초침)로 피부 재생을 유도하는 치료법. 내부적으로는 면역력 강화 한약 처방을 병행' },
  'keratosis-pilaris': { name: '화안케어 프로그램', desc: '화접몽한의원의 화안케어(미세약초침 치료)로 모공 주변 각질을 정상화하고 피부결을 개선하는 치료법. 미세한 침으로 한약 추출물 성분을 피부에 직접 전달하여 피부 재생을 유도' },
  'acne': { name: '화안케어 + 한약 도포 치료', desc: '한약 추출물을 이용한 미세침 치료인 화안케어를 통해 피지선 활동을 줄이고 염증을 완화하며, 피부 상태에 따라 한약 도포, 고밀도 AMTS 등을 병행하는 맞춤형 여드름 치료' },
  'acne-scars': { name: '화안케어 + 고밀도 AMTS', desc: '화안케어(미세약초침)와 고밀도 AMTS를 활용하여 패인 흉터와 색소침착을 개선하고, 한약 도포로 피부 재생과 장벽 회복을 돕는 치료법' },
  'folliculitis': { name: '화안케어 + 한약 치료', desc: '외부 치료로 화안케어(미세약초침)를 시행하여 모낭 염증을 완화하고, 내부적으로 체질에 맞는 한약 처방으로 면역력을 회복하는 안팎 병행 치료' },
  'atopic-dermatitis': { name: '화안케어 + 체질 한약', desc: '체질 진단을 기반으로 한약 처방과 화안케어(미세약초침) 외용 치료를 병행하여 면역 균형을 회복하고 피부 장벽을 강화하는 치료법' },
  'psoriasis': { name: '화안케어 + 면역 한약', desc: '한약 치료를 통해 면역 균형을 조절하고, 화안케어로 피부 염증을 외부에서 완화하여 재발을 줄이는 치료법' },
  'dyshidrosis': { name: '화안케어 + 습열 한약', desc: '체질에 맞는 한약 처방으로 체내 습열을 제거하고, 화안케어로 피부 장벽을 회복하는 치료법' },
  'diet': { name: '감비환 다이어트', desc: '화접몽한의원의 체질 맞춤 한약 처방인 감비환과 식이 관리를 병행하는 한방 체중 관리 프로그램' },
  'seborrheic-dermatitis': { name: '화안케어 + 청열 한약', desc: '한약 치료로 체내 열과 습을 조절하고, 피부 상태에 따라 화안케어를 활용하여 피부 염증을 완화하는 치료법' },
};

// ─── Google Gemini API 호출 헬퍼 ───
async function callGemini(apiKey, systemPrompt, userPrompt, options = {}) {
  const FALLBACK_MODELS = [AI_CONFIG.model, 'gemini-2.5-flash'];
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
기존 키워드: ${(topic.keywords || []).join(', ')}
서브토픽: ${(topic.subtopics || []).length > 0 ? topic.subtopics.join(', ') : '없음'}

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
- 40자 이내, 질환명 + 핵심 키워드를 포함한 자연스러운 서술형 제목
- 괄호() 사용 금지
${['korean-medicine-treatment','case-study','comparison'].includes(contentType.id) ? `- ★브랜드 포함★: 이 콘텐츠 유형은 제목에 "${BRAND.name}" 또는 치료법명(화안케어, 거우침 등)을 자연스럽게 포함하세요
- 브랜드 포함 예시 (구조를 다양하게):
  * "편평사마귀 거우침 치료, 화접몽한의원의 접근법"
  * "여드름 흉터가 남기 전에 화안케어를 고려해야 하는 이유"
  * "화접몽한의원이 지루성피부염을 다루는 방식"
  * "모공각화증, 화안케어로 달라질 수 있습니다"` : `- 브랜드명(화접몽)은 제목에 넣지 않아도 됩니다. 질환 중심으로 작성하세요
- 일반 예시 (구조를 다양하게 — 매번 다른 패턴 사용):
  * 서술형: "편평사마귀는 단순 제거만으로 부족합니다"
  * 질문형: "왜 편평사마귀는 자꾸 같은 자리에 생길까"
  * 공감형: "모공각화증 때문에 반팔이 꺼려진다면"
  * 정보형: "여드름 흉터가 남기 전에 알아야 할 것들"
  * 전환형: "건선은 피부가 보내는 면역 신호입니다"`}
- ★제목 다양성★: 매번 "질환명," 콤마로 시작하는 패턴을 반복하지 마세요. 질문형, 서술형, 공감형 등 다양한 구조를 번갈아 사용하세요.
- "한방 치료"를 제목에 매번 넣지 마세요. 3건 중 1건 정도만 치료 키워드를 제목에 포함하고, 나머지는 증상·원인·관리 관점의 제목으로 작성하세요.
- 금지 패턴: "~란?", "~의 모든 것", "~의 비밀", "혹시 나도?", "알고 계셨나요?", "완벽 가이드", "총정리"
- "집에서 관리하는 법", "생활 꿀팁", "자가 관리법", "홈케어" 같은 생활관리 제목 금지
- "최고", "유일", "완치" 등 의료법 위반 표현 금지
- 백과사전식 제목 금지: "~란? 원인·증상·치료법" 패턴 절대 금지
${existingTitles.length > 0 ? `
[기존 콘텐츠와 차별화 - 매우 중요]
다음 제목의 콘텐츠가 이미 존재합니다. 반드시 다른 관점, 구조, 제목으로 작성하세요:
${existingTitles.map(t => `- "${t}"`).join('\n')}
` : ''}
[소제목(H2) 작성 규칙 - 매우 중요]
- 질문형과 키워드형을 섞어 작성하세요. 딱딱한 백과사전식 소제목 금지!
- 질문형 예시: "왜 재발이 반복될까", "한의원 치료는 어떻게 다른가"
- 키워드형 예시: "편평사마귀 재발의 핵심 원인", "화안케어 치료 과정과 효과"
- 나쁜 예: "편평사마귀의 정의와 특징", "주요 원인", "치료 방법 및 예후"
- 금지 패턴: "~의 정의", "~의 원인", "~의 특징", "~의 개요", "~의 모든 것", "혹시 나도?"
- 매번 질문형 2~3개 + 키워드형 2~3개를 혼용하세요
- ${topic.name} 토픽에 깊이 집중하는 내용으로 구성하세요`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.7,
  });

  return JSON.parse(result);
}

// ─── Stage 3: 프로덕션 AI (핵심) ───
async function stageProduction(apiKey, topic, contentType, strategy) {
  const referenceContent = loadReferenceContent(topic);
  const homepageContent = await fetchHomepageContent();
  const subtopicsInfo = getSubtopicsInfo(topic);
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

  const systemPrompt = `당신은 피부질환 전문 의료 블로그 글을 작성하는 콘텐츠 작성자입니다.
${BRAND.name}의 치료 정보를 바탕으로, 3인칭 블로그 글 형태로 작성합니다. 의사 1인칭 화법("저희 병원에서는~", "진료실에서~")은 사용하지 않습니다.

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
1. ★최우선★ 레퍼런스 톤 따르기: 위 레퍼런스 샘플과 동일한 글쓰기 스타일로 작성하세요. 이것이 가장 중요한 규칙입니다.
2. 어미: "~합니다/~입니다/~됩니다/~있습니다/~좋습니다/~필요합니다" 등 ~다 체를 다양하게 섞으세요. ~요 체 금지.
3. 문장 흐름: 접속사("그래서", "다만", "특히", "실제로")를 활용해 문장 간 자연스러운 연결을 만드세요. 단순 나열 금지.
4. 문단: 한 <p>에 2~3문장만. 4줄 이상 금지.
5. 시점: 3인칭 블로그 글 시점. "진료실에서~", "저희 병원에서~" 같은 의사 화법 금지.
6. 금지 표현: 클릭베이트(충격, 놀라운 등), 과장된 치료 효과, 억지 질문형 도입("~있으신가요?")
7. 브랜드: "${BRAND.name}" 본문에서 2~3회만 자연스럽게 삽입
8. 구조: 전략(outline)에 정의된 구조를 따르되, 블로그처럼 읽기 쉬운 흐름으로 작성
9. 분량: 약 ${wordCount}자 내외
10. 전문 용어: 한의학 용어는 쉬운 비유와 함께 풀어서 설명
11. 마무리: 글의 마지막 문단은 본문 흐름을 자연스럽게 마무리하면서, "개인별 체질과 증상에 따라 치료 결과가 다를 수 있으므로 전문가 상담을 통해 본인에게 맞는 방법을 찾아보시길 권합니다" 같은 면책 취지를 녹여 주세요. 뜬금없이 한 줄로 끊지 마세요.
12. 다양성: 이전 콘텐츠와 다른 표현, 비유, 예시 사용
13. 토픽 집중: ${topic.name}에 대한 심도 있는 정보 중심
14. 언어: 한국어로만 작성. 의학 용어 영문 병기만 허용.
15. 출처: 학술 논문/연구 인용 절대 금지. 일반적 의학 상식만 활용.
${caseStudySafety}

반드시 JSON 형식으로만 응답하세요.

${subtopicsInfo}

${homepageContent}

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
  "content": "HTML 본문 (<h2>로 대주제 3~5개, 일부 <h2> 아래에 <h3>로 소주제 2~3개 배치, <p> 위주, 한 <p>에 2~3문장, ~다 체 어미, 약 ${wordCount}자)",
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
- 글 마지막 문단에서 본문 내용을 자연스럽게 정리하면서 "체질과 증상에 따라 결과가 다를 수 있으니 전문가 상담을 권합니다" 취지의 면책을 녹여 주세요. 별도 한 줄로 뚝 떨어뜨리지 마세요.
- references 필드는 포함하지 마세요 (가짜 인용 방지)
- ${topic.name} 토픽에 깊이 집중하세요: 원인, 증상, 치료, 관리법 등을 구체적이고 실질적으로 다루세요
- 헤딩 구조: <h2>는 대주제로 3~5개 사용하고, 내용이 풍부한 <h2> 섹션 2~3곳에서 <h3>를 활용해 세부 항목을 나누세요. <h3>는 해당 <h2> 흐름 안에서 자연스럽게 이어지는 소주제여야 합니다. 모든 <h2>에 <h3>를 넣을 필요는 없고, 종류·유형·단계 등 세분화가 자연스러운 부분에만 넣으세요.
- 기존 콘텐츠와 차별화: 새로운 비유, 예시, 표현을 적극 활용하세요
- 언어 규칙: 전체 콘텐츠를 반드시 한국어로만 작성하세요. 영어 문장이나 영어 표현을 섞지 마세요. 의학 용어 영문 병기만 예외적으로 허용됩니다.
- 지역 키워드 반영: ${(topic.keywords || []).length > 0 ? '본문 중 자연스러운 문맥에서 다음 키워드를 1~2회만 녹여주세요: ' + topic.keywords.map(k => '"' + k + '"').join(', ') + '. 억지로 키워드를 나열하지 말고, 치료 설명이나 사례 소개 흐름 속에서 자연스럽게 언급하세요.' : '별도 지역 키워드 없음.'}
- 키워드 밀도: 제목에 포함된 핵심 단어(질환명, 치료법명 등)를 본문에서 각각 2~3회 이상 자연스럽게 반복 사용하세요. 예를 들어 제목에 "${topic.name}"이 있으면 본문 곳곳에서 "${topic.name}"을 자연스럽게 언급하세요. 단, 한 문단에 같은 키워드를 2번 이상 넣지는 마세요.`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    maxTokens: 8192,
    temperature: 0.85,
  });

  return JSON.parse(result);
}

// ─── Pexels 검색어 다양화 (질환별 쿼리 풀) ───
const IMAGE_QUERY_POOLS = {
  'flat-warts': ['asian dermatology clinic', 'korean herbal medicine skin', 'acupuncture therapy asian', 'hand skin care asian woman', 'traditional medicine consultation', 'oriental medicine herbs skin', 'moxibustion treatment'],
  'plantar-warts': ['foot care asian clinic', 'acupuncture foot treatment', 'herbal foot soak oriental', 'foot massage therapy asian', 'traditional medicine foot care', 'oriental herbal remedy', 'asian wellness foot'],
  'genital-warts': ['asian medical consultation', 'herbal medicine preparation oriental', 'traditional korean medicine clinic', 'immune health asian wellness', 'oriental medicine doctor', 'herbal tea asian health', 'medical privacy care'],
  'warts-treatment': ['oriental medicine herbs treatment', 'acupuncture session asian', 'korean herbal cream remedy', 'traditional medicine skin care', 'asian dermatology treatment', 'moxibustion therapy skin', 'herbal medicine preparation'],
  'atopic-dermatitis': ['asian sensitive skin care', 'herbal bath therapy oriental', 'korean skincare routine', 'traditional medicine eczema', 'oriental herbal moisturizer', 'asian woman skin care', 'gentle herbal remedy skin'],
  'acne-treatment': ['asian skincare routine acne', 'herbal face mask oriental', 'korean beauty skin care', 'traditional medicine acne', 'asian clear skin facial', 'oriental herbal skin detox', 'asian woman clean skin'],
  'urticaria': ['asian allergy treatment herbal', 'oriental medicine immune', 'herbal tea remedy asian', 'acupuncture allergy asian', 'traditional medicine wellness', 'asian calming herbal tea', 'oriental health lifestyle'],
  'psoriasis': ['oriental medicine scalp treatment', 'asian herbal medicine chronic', 'acupuncture psoriasis asian', 'traditional korean medicine herbs', 'herbal skin renewal oriental', 'asian holistic health', 'moxibustion therapy'],
  'hair-loss': ['asian scalp treatment clinic', 'korean herbal hair remedy', 'acupuncture scalp asian', 'oriental medicine hair growth', 'asian hair care traditional', 'herbal hair treatment oriental', 'asian woman healthy hair'],
  'seborrheic-dermatitis': ['asian scalp care herbal', 'oriental medicine scalp', 'korean herbal shampoo treatment', 'traditional medicine dandruff', 'asian gentle scalp care', 'herbal scalp remedy oriental', 'asian skin microbiome'],
};

const IMAGE_GENERAL_POOL = [
  'korean traditional medicine clinic', 'oriental herbal medicine preparation', 'acupuncture treatment asian',
  'asian wellness herbal tea', 'traditional korean medicine doctor', 'oriental medicine herbs mortar',
  'asian patient care clinic', 'moxibustion therapy treatment', 'korean herbal medicine cabinet',
  'asian holistic health care', 'traditional oriental medicine', 'herbal medicine asian clinic',
];

// 동양 이미지 보강 키워드 (검색어에 자동 추가)
const ORIENTAL_BOOST = ['asian', 'korean', 'oriental', 'traditional medicine'];

function diversifyImageQuery(baseQuery, topicId) {
  const pool = IMAGE_QUERY_POOLS[topicId] || IMAGE_GENERAL_POOL;
  if (Math.random() < 0.7) {
    return pickRandom(pool);
  }
  // 일반 풀에서 선택 시에도 동양 키워드 보강
  const generalQuery = pickRandom(IMAGE_GENERAL_POOL);
  return generalQuery;
}

// ─── 이미지 가져오기 (Pixabay — 1순위) ───
async function fetchPixabayImages(apiKey, query, count = 3) {
  if (!apiKey) return [];
  try {
    const randomPage = Math.floor(Math.random() * 3) + 1;
    const response = await fetch(
      `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=${Math.max(count, 3)}&page=${randomPage}&orientation=horizontal&image_type=photo&lang=ko&category=health`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.hits || []).map((hit) => ({
      url: hit.webformatURL,
      alt: hit.tags || query,
      photographer: hit.user,
      photographerUrl: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`,
      sourceUrl: hit.pageURL,
      source: 'Pixabay',
    }));
  } catch (error) {
    console.error('Pixabay API error:', error);
    return [];
  }
}

// ─── 이미지 가져오기 (Unsplash — 2순위) ───
async function fetchUnsplashImages(apiKey, query, count = 3) {
  if (!apiKey) return [];
  try {
    const randomPage = Math.floor(Math.random() * 3) + 1;
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&page=${randomPage}&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${apiKey}` } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.results || []).map((photo) => ({
      url: photo.urls.regular,
      alt: photo.alt_description || query,
      photographer: photo.user.name,
      photographerUrl: photo.user.links.html,
      sourceUrl: photo.links.html,
      source: 'Unsplash',
    }));
  } catch (error) {
    console.error('Unsplash API error:', error);
    return [];
  }
}

// ─── 이미지 가져오기 (Pexels — 3순위) ───
async function fetchPexelsImages(apiKey, query, count = 3) {
  if (!apiKey) return [];
  try {
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
      sourceUrl: photo.url,
      source: 'Pexels',
    }));
  } catch (error) {
    console.error('Pexels API error:', error);
    return [];
  }
}

// ─── 이미지 폴백 검색 (Pixabay → Unsplash → Pexels) ───
async function fetchImagesWithFallback(env, query, count = 3) {
  const sources = [
    { name: 'Pixabay', key: env.PIXABAY_API_KEY, fn: fetchPixabayImages },
    { name: 'Unsplash', key: env.UNSPLASH_ACCESS_KEY, fn: fetchUnsplashImages },
    { name: 'Pexels', key: env.PEXELS_API_KEY, fn: fetchPexelsImages },
  ];

  let collected = [];
  for (const src of sources) {
    if (collected.length >= count) break;
    if (!src.key) continue;
    const needed = count - collected.length;
    console.log(`[이미지] ${src.name}에서 ${needed}장 검색: "${query}"`);
    const result = await src.fn(src.key, query, needed);
    collected = collected.concat(result);
  }

  if (collected.length > count) collected = collected.slice(0, count);
  console.log(`[이미지] 최종 ${collected.length}장 확보 (소스: ${[...new Set(collected.map(i => i.source))].join(', ') || '없음'})`);
  return collected;
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
      const sourceName = img.source || 'Pexels';
      const sourceUrl = img.sourceUrl || img.pexelsUrl || '#';
      const imgHtml = `</h2>
<figure class="wp-block-image">
  <img src="${img.url}" alt="${altText}" loading="lazy" />
  <figcaption>사진: <a href="${img.photographerUrl}" target="_blank">${img.photographer}</a> / <a href="${sourceUrl}" target="_blank">${sourceName}</a></figcaption>
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
export function calculateGeoScore(content, title, metaDescription, faq, schemas) {
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
export function calculateEeatScore(content, title) {
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


// ─── 소제목 앞 단락 여백 추가 (가독성 향상) ───
function addHeadingSpacing(html) {
  if (!html) return html;
  // <h2>, <h3> 태그 앞에 margin-top 스타일 추가 (이미 style 속성이 있으면 병합)
  html = html.replace(/<h2(\s*)(>|(\s[^>]*)>)/g, function(match, space, rest, attrs) {
    if (attrs && attrs.includes('margin-top')) return match;
    if (attrs && attrs.includes('style="')) {
      return match.replace('style="', 'style="margin-top:2.5em; ');
    }
    return '<h2 style="margin-top:2.5em"' + (attrs || '') + '>';
  });
  html = html.replace(/<h3(\s*)(>|(\s[^>]*)>)/g, function(match, space, rest, attrs) {
    if (attrs && attrs.includes('margin-top')) return match;
    if (attrs && attrs.includes('style="')) {
      return match.replace('style="', 'style="margin-top:1.8em; ');
    }
    return '<h3 style="margin-top:1.8em"' + (attrs || '') + '>';
  });
  return html;
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

  // 이미지 가져오기 (3종 API 폴백: Pixabay → Unsplash → Pexels)
  const imageCount = options.imagesPerContent || 3;
  const diversifiedQuery = diversifyImageQuery(topic.pexelsQuery, topic.id);
  const images = await fetchImagesWithFallback(env, diversifiedQuery, imageCount);

  // 콘텐츠 조립
  let finalContent = cleanedProduction.content;

  // 소제목 앞 단락 여백 추가 (가독성 향상)
  finalContent = addHeadingSpacing(finalContent);

  // AI 콘텐츠 자동 검수 (의료법 위반 + 과장 광고 체크 및 자동 치환)
  const reviewResult = reviewContent(finalContent, cleanedProduction.title);
  finalContent = reviewResult.content;
  cleanedProduction.title = reviewResult.title;
  if (reviewResult.fixes.length > 0) {
    console.log(`[검수] ${reviewResult.summary.total}건 치환 완료 (의료법: ${reviewResult.summary.high}, 과장광고: ${reviewResult.summary.medium})`);
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
