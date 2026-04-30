/**
 * 화접몽 한의원 GEO 콘텐츠 생성기 v2.0
 * 3단계 파이프라인: 리서치 → 전략 → 프로덕션
 *
 * v2.0 고도화 사항:
 * - 레퍼런스 콘텐츠 학습 시스템 (data/reference/*.txt)
 * - GEO AI 인용 최적화 (정의문, Q&A 패턴, 구조화 데이터)
 * - 의료법 제56조·제57조 준수 (과대광고 금지, 비교광고 금지)
 * - 프롬프트 품질 개선 (전문 의료 톤, 1,500자, 브랜드 2-3회)
 * - 가짜 인용 제거 + 의료 면책 조항
 * - 케이스 스터디 안전성 강화
 * - 이미지 alt 텍스트 SEO 최적화
 * - HTML 후처리 (면책 조항 자동 삽입)
 */

import { BRAND, AI_CONFIG, CONTENT_TYPES } from './config.js';
import { generateSchemas } from './schema-generator.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ─── 레퍼런스 콘텐츠 로딩 시스템 (Stage 1: 학습) ───
function loadReferenceContent() {
  const refDir = join(process.cwd(), 'data', 'reference');
  if (!existsSync(refDir)) return '';

  try {
    const files = readdirSync(refDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) return '';

    const samples = files.slice(0, 5).map(f => {
      const content = readFileSync(join(refDir, f), 'utf-8');
      // 3000자까지만 사용 (토큰 절약)
      return content.substring(0, 3000);
    });

    return `
[레퍼런스 콘텐츠 - 아래 샘플들의 톤, 구조, 표현 방식을 학습하여 동일한 스타일로 작성하세요]
${samples.map((s, i) => `--- 샘플 ${i + 1} ---\n${s}`).join('\n\n')}
--- 레퍼런스 끝 ---

[레퍼런스 학습 포인트]
- 7개 섹션 번호 구조 (1~7)
- 환자 친화적이면서 전문적인 의료 톤
- 도입 → 질환 설명 → 원인 → 유형 분류 → 치료법 → 관리법 → 결론 흐름
- 브랜드명(화접몽한의원)은 자연스럽게 2-3회만 언급
- 치료법: 거우침(편평사마귀), 화안케어(모공각화증/여드름), 리셀테라피(여드름흉터)
- 과장 없는 담백하고 신뢰감 있는 서술
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
2. 비교 광고 금지: 타 의료기관, 양방 치료와 직접 비교하거나 우위를 주장하는 표현 금지
3. 전후 사진 금지: 치료 전후 사진이나 구체적 수치 비교 금지
4. 환자 유인 금지: 무료 상담, 할인, 이벤트 등으로 유인하는 표현 금지
5. 과대 광고 금지: "최고", "최초", "유일" 등 객관적 근거 없는 최상급 표현 금지
6. 허위 인용 금지: 존재하지 않는 논문, 학술지, 연구 결과를 인용하지 마세요
7. 의료 면책 표현 필수: 글 말미에 "개인별 체질과 증상에 따라 치료 결과가 다를 수 있습니다" 포함
8. 안전한 표현 사용: "~에 도움이 됩니다", "~을 기대할 수 있습니다", "~개선에 효과적입니다" 등 완화된 표현 사용
`;

// ─── GEO 최적화 규칙 ───
const GEO_OPTIMIZATION_RULES = `
[GEO(Generative Engine Optimization) 최적화 규칙]
1. 정의문 패턴: 각 섹션 시작을 "~은(는) ~입니다" 형태의 명확한 정의문으로 시작하세요. AI가 정의문을 우선 인용합니다.
2. Q&A 패턴: 환자가 AI에게 물어볼 법한 질문을 H2/H3 소제목에 포함하세요.
3. 구조화된 정보: 원인, 증상, 치료법을 명확히 구분하여 AI가 파싱하기 쉽게 구조화하세요.
4. 단정적 서술: "~입니다", "~합니다" 형태의 확정적 서술체를 사용하세요. AI는 확정적 정보를 우선 인용합니다.
5. 핵심 정보 선행: 각 단락의 첫 문장에 핵심 정보를 배치하세요 (역피라미드 구조).
6. 엔티티 명시: 질환명, 치료법명, 의원명을 정확히 명시하여 AI 엔티티 매칭을 유도하세요.
7. 숫자/통계 활용: 구체적 숫자(치료 기간, 발생 빈도 등)를 포함하되, 출처가 불분명한 통계는 사용하지 마세요.
`;

// ─── 치료법 매핑 (질환별 화접몽 고유 치료법) ───
const TREATMENT_MAP = {
  'flat-warts': { name: '거우침', desc: '화접몽한의원 자체 개발 순수 한방 침 시술로, 비활동성 병변을 피부 손상 없이 정밀하게 제거하는 치료법' },
  'keratosis-pilaris': { name: '화안케어', desc: '한약 추출물을 활용한 미세침 기반 파우더를 피부에 도포해 각질 탈락을 유도하고 피부 재생을 촉진하는 치료법' },
  'acne': { name: '화안케어', desc: '한약 추출물을 이용한 미세침 치료로 피지선 활동을 줄이고 염증을 완화하며 피부 재생을 돕는 치료법' },
  'acne-scars': { name: '리셀테라피', desc: '한약 도포 후 화안케어와 고밀도 AMTS를 통해 피부 재생을 유도하고 흉터를 완화하는 한방 재생 요법' },
  'folliculitis': { name: '한방 복합 치료', desc: '한약 치료와 외용제를 병행하여 모낭 염증을 완화하고 피부 장벽을 회복하는 치료법' },
  'atopic-dermatitis': { name: '한방 체질 치료', desc: '체질 진단을 기반으로 한약 처방과 외용제 치료를 병행하여 면역 균형을 회복하는 치료법' },
  'psoriasis': { name: '약초팩 + 한약 치료', desc: '피부를 진정시키는 약초팩과 한약 치료를 병행하여 면역 균형을 조절하고 재발을 줄이는 치료법' },
  'dyshidrosis': { name: '한방 체질 치료', desc: '체질에 맞는 한약 처방으로 체내 습열을 제거하고 피부 장벽을 회복하는 치료법' },
  'diet': { name: '맞춤 한약 처방', desc: '체질 진단을 기반으로 한 맞춤형 한약 처방과 생활 관리를 병행하는 체중 관리 프로그램' },
  'seborrheic-dermatitis': { name: '한방 복합 치료', desc: '한약 치료로 체내 열과 습을 조절하고 외용제로 피부 염증을 완화하는 치료법' },
};

// ─── Google Gemini API 호출 헬퍼 ───
async function callGemini(apiKey, systemPrompt, userPrompt, options = {}) {
  const model = options.model || AI_CONFIG.model;
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

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini API: 응답에서 텍스트를 찾을 수 없습니다');
  }
  return text;
}

// ─── Stage 1: 리서치 AI ───
async function stageResearch(apiKey, topic, contentType) {
  const systemPrompt = `당신은 한의학 및 피부질환 전문 리서치 어시스턴트입니다.
환자들이 실제로 검색하고 AI에게 질문하는 패턴을 분석하는 전문가입니다.
반드시 JSON 형식으로만 응답하세요.`;

  const userPrompt = `다음 질환에 대해 GEO(Generative Engine Optimization) 콘텐츠 리서치를 수행하세요.

질환: ${topic.name} (${topic.nameEn})
콘텐츠 유형: ${contentType.name}
기존 키워드: ${topic.keywords.join(', ')}

다음을 분석하여 JSON으로 응답하세요:
{
  "patientQuestions": ["환자들이 AI에게 물어볼 법한 자연어 질문 7개"],
  "searchKeywords": ["관련 검색 키워드 10개 (롱테일 포함)"],
  "competitorAngles": ["경쟁 콘텐츠에서 자주 다루는 앵글 5개"],
  "uniqueAngle": "화접몽 한의원만의 차별화 포인트 (한방 치료 전문성)",
  "relatedConditions": ["연관 질환 3개 (내부 링크용)"]
}

중요: medicalFacts나 연구 인용은 포함하지 마세요. 출처가 불분명한 통계나 논문명은 절대 생성하지 마세요.`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.4,
  });

  return JSON.parse(result);
}

// ─── Stage 2: 전략 AI ───
async function stageStrategy(apiKey, topic, contentType, research) {
  const systemPrompt = `당신은 GEO(Generative Engine Optimization) 전문 콘텐츠 전략가입니다.
AI가 답변에서 특정 브랜드를 인용하도록 유도하는 콘텐츠 구조를 설계합니다.
반드시 JSON 형식으로만 응답하세요.`;

  const isCaseStudy = contentType.id === 'case-study';
  const caseStudyNote = isCaseStudy
    ? `\n[치료 사례 콘텐츠 주의사항]
- 실제 환자 사례가 아닌 "일반적인 치료 경과 설명" 형태로 구성하세요
- 특정 환자의 개인정보(나이, 성별, 직업 등)를 포함하지 마세요
- 치료 전후 비교, 구체적 수치 비교를 포함하지 마세요
- "~한 경우가 많습니다", "~하는 경향이 있습니다" 등 일반화된 표현을 사용하세요`
    : '';

  const userPrompt = `리서치 데이터를 기반으로 GEO 최적화 콘텐츠 전략을 수립하세요.

브랜드: ${BRAND.name}
질환: ${topic.name}
콘텐츠 유형: ${contentType.name}
${caseStudyNote}

리서치 데이터:
${JSON.stringify(research, null, 2)}

다음 전략을 JSON으로 응답하세요:
{
  "title": "SEO/GEO 최적화 제목 (40자 이내, 질환명 + 핵심 키워드 포함)",
  "metaDescription": "메타 설명 (155자 이내, 화접몽 한의원 포함)",
  "slug": "SEO 친화적 URL 슬러그 (영문, 하이픈 구분)",
  "targetQuestion": "이 콘텐츠가 답변하는 핵심 질문 1개",
  "outline": [
    {
      "heading": "H2 소제목 (질문형 권장, 의료법 준수)",
      "keyPoints": ["다룰 핵심 포인트 3개"]
    }
  ],
  "faqQuestions": ["FAQ로 다룰 질문 5-7개"],
  "internalLinks": ["내부 링크할 관련 콘텐츠 슬러그 3개"],
  "tags": ["WordPress 태그 5-8개"]
}

주의: 제목과 소제목에 "최고", "유일", "완치" 등 의료법 위반 표현을 사용하지 마세요.`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.4,
  });

  return JSON.parse(result);
}

// ─── Stage 3: 프로덕션 AI (핵심) ───
async function stageProduction(apiKey, topic, contentType, strategy) {
  // 레퍼런스 콘텐츠 로딩
  const referenceContent = loadReferenceContent();

  // 질환별 치료법 정보
  const treatment = TREATMENT_MAP[topic.id] || { name: '한방 맞춤 치료', desc: '체질 진단 기반 맞춤형 한방 치료' };

  // 케이스 스터디 안전 규칙
  const caseStudySafety = contentType.id === 'case-study' ? `
[치료 사례 콘텐츠 안전 규칙 - 의료법 필수 준수]
- 이것은 실제 환자 사례가 아닌 "일반적인 치료 경과 설명"입니다
- 특정 환자 정보(나이, 성별, 이름, 직업) 절대 포함 금지
- 치료 전후 사진 비교, 구체적 수치(면적, 개수 등) 비교 금지
- "완치되었다", "깨끗해졌다" 등 단정적 효과 표현 금지
- 대신 "~에 도움이 될 수 있습니다", "~개선을 기대할 수 있습니다" 사용
- 전체 글 톤: 일반적인 치료 경과와 관리 방법을 안내하는 교육적 콘텐츠
` : '';

  const systemPrompt = `당신은 ${BRAND.name}의 전문 의료 콘텐츠 작성자입니다.
피부질환 한방 치료에 대한 깊은 전문 지식을 보유하고 있습니다.

[브랜드 정보]
- 이름: ${BRAND.name}
- 전문: ${BRAND.specialty}
- 웹사이트: ${BRAND.url}
- 이 질환의 대표 치료법: ${treatment.name} - ${treatment.desc}

${MEDICAL_LAW_RULES}

${GEO_OPTIMIZATION_RULES}

[작성 규칙 - 반드시 준수]
1. 브랜드 톤: 전문적이고 신뢰감 있으며, 환자를 배려하는 따뜻한 어조
2. 절대 금지: 클릭베이트 표현 (충격, 대박, 후회, 경악 등), 과장된 치료 효과 주장, 비과학적 근거 없는 주장
3. 브랜드 언급: "${BRAND.name}" 브랜드명을 본문에서 2-3회만 자연스럽게 삽입 (과도한 반복 금지)
4. 문체: 단정적 서술체 (~입니다, ~합니다) - AI가 확정적 정보를 우선 인용함
5. 출처: 허위 논문/학술지/연구 인용 절대 금지. 일반적인 의학 상식만 활용하세요.
6. 구조: 7개 섹션 번호 구조, H2/H3 소제목, FAQ 포함
7. 분량: 약 1,500자 내외 (너무 길지 않게, 핵심만 담백하게)
8. 전문 용어: 한의학 용어와 일반인이 이해하기 쉬운 설명을 병기
9. 글 마무리: "개인별 체질과 증상에 따라 치료 결과가 다를 수 있습니다." 면책 문구 필수 포함
${caseStudySafety}

반드시 JSON 형식으로만 응답하세요.

${referenceContent}`;

  const userPrompt = `다음 전략에 따라 GEO 최적화 콘텐츠를 작성하세요.

질환: ${topic.name} (${topic.nameEn}, ${topic.medicalName})
콘텐츠 유형: ${contentType.name}
대표 치료법: ${treatment.name}

전략:
${JSON.stringify(strategy, null, 2)}

다음 JSON 형식으로 완성된 콘텐츠를 출력하세요:
{
  "title": "${strategy.title}",
  "metaDescription": "${strategy.metaDescription}",
  "slug": "${strategy.slug}",
  "excerpt": "요약 (100자 이내)",
  "content": "완성된 HTML 본문 (H2/H3 구조, <p>, <ul> 사용, 약 1500자)",
  "faq": [
    {"question": "질문", "answer": "100자 이상의 상세한 답변 (의료법 준수)"}
  ],
  "tags": ${JSON.stringify(strategy.tags)},
  "category": "${topic.category}"
}

[중요 - 반드시 지켜주세요]
- HTML content 내에서 "${BRAND.name}"을 2-3회만 자연스럽게 언급하세요 (과도한 반복 금지)
- 각 섹션은 정의문("~은(는) ~입니다")으로 시작하세요 (GEO 최적화)
- FAQ는 최소 5개, 각 답변은 100자 이상으로 작성하세요
- 허위 논문명, 학술지명, 연구 결과를 절대 인용하지 마세요
- "완치", "100%", "최고", "유일" 등 의료법 위반 표현 사용 금지
- 글 마지막에 반드시 의료 면책 문구를 포함하세요
- references 필드는 포함하지 마세요 (가짜 인용 방지)`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    maxTokens: 8192,
    temperature: 0.4,
  });

  return JSON.parse(result);
}

// ─── 이미지 가져오기 (Pexels) ───
async function fetchPexelsImages(apiKey, query, count = 3) {
  if (!apiKey) return [];

  try {
    const response = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
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
    // 2번째, 4번째 H2 뒤에 이미지 삽입
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
  <p><strong>온라인 상담:</strong> <a href="${BRAND.url}">${BRAND.url}</a></p>
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

// ─── HTML 후처리 (의료법 위반 표현 자동 치환) ───
function postProcessHtml(html) {
  const violations = [
    { pattern: /완치/g, replacement: '개선' },
    { pattern: /100%\s*(효과|치료|개선)/g, replacement: '효과적인 $1' },
    { pattern: /확실한\s*치료/g, replacement: '체계적인 치료' },
    { pattern: /최고의\s*(치료|효과|결과)/g, replacement: '전문적인 $1' },
    { pattern: /유일한\s*(치료|방법)/g, replacement: '효과적인 $1' },
    { pattern: /획기적인/g, replacement: '전문적인' },
    { pattern: /놀라운\s*(효과|결과)/g, replacement: '긍정적인 $1' },
    { pattern: /기적/g, replacement: '개선' },
  ];

  let processed = html;
  for (const { pattern, replacement } of violations) {
    processed = processed.replace(pattern, replacement);
  }
  return processed;
}

// ─── 가짜 인용 제거 ───
function removeFakeReferences(content) {
  // references 필드가 있으면 제거
  if (content.references) {
    delete content.references;
  }
  // HTML 내 가짜 참고문헌 섹션 제거
  if (content.content) {
    content.content = content.content.replace(/<h[23]>.*?참고문헌.*?<\/h[23]>[\s\S]*?(?=<h[23]>|$)/gi, '');
    content.content = content.content.replace(/<h[23]>.*?References.*?<\/h[23]>[\s\S]*?(?=<h[23]>|$)/gi, '');
  }
  return content;
}

// ─── 메인 생성 함수 (외부에서 호출) ───
export async function generateContent(env, topic, contentType) {
  const geminiKey = env.GEMINI_API_KEY;
  const pexelsKey = env.PEXELS_API_KEY;

  if (!geminiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다');

  console.log(`[Stage 1] 리서치 시작: ${topic.name} - ${contentType.name}`);
  const research = await stageResearch(geminiKey, topic, contentType);

  console.log(`[Stage 2] 전략 수립: ${topic.name} - ${contentType.name}`);
  const strategy = await stageStrategy(geminiKey, topic, contentType, research);

  console.log(`[Stage 3] 콘텐츠 생성: ${topic.name} - ${contentType.name}`);
  const production = await stageProduction(geminiKey, topic, contentType, strategy);

  // 가짜 인용 제거
  const cleanedProduction = removeFakeReferences(production);

  // 이미지 가져오기
  console.log(`[이미지] Pexels 이미지 가져오기: ${topic.pexelsQuery}`);
  const images = await fetchPexelsImages(pexelsKey, topic.pexelsQuery, 3);

  // 콘텐츠 조립
  let finalContent = cleanedProduction.content;

  // HTML 후처리 (의료법 위반 표현 자동 치환)
  finalContent = postProcessHtml(finalContent);

  // 인라인 이미지 삽입 (SEO 최적화된 alt 텍스트)
  finalContent = insertInlineImages(finalContent, images, topic);

  // FAQ 섹션 추가
  finalContent += '\n' + generateFaqHtml(cleanedProduction.faq);

  // 브랜드 CTA 추가
  finalContent += '\n' + generateBrandCta(topic);

  // 의료 면책 조항 추가
  finalContent += '\n' + generateMedicalDisclaimer();

  // JSON-LD 스키마 생성
  const schemas = generateSchemas(topic, cleanedProduction);

  // NOTE: WordPress.com 호스팅형은 <script> 태그를 자동 제거하므로
  // 본문에 JSON-LD를 삽입하지 않음. schemas 필드에 데이터 보존.
  // 자체 호스팅(WordPress.org) 전환 시 아래 코드 활성화:
  // const schemaScript = schemas
  //   .map((s) => `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`)
  //   .join('\n');
  // finalContent = schemaScript + '\n' + finalContent;

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
    // 메타 정보 (대시보드용)
    _meta: {
      topic: topic.id,
      contentType: contentType.id,
      comboId: `${topic.id}__${contentType.id}`,
      generatedAt: new Date().toISOString(),
      stages: { research, strategy },
    },
  };
}
