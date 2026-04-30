/**
 * 화접몽 한의원 GEO 콘텐츠 생성기
 * 3단계 파이프라인: 리서치 → 전략 → 프로덕션
 *
 * KOCOBOX 대비 개선점:
 * - 단일 프롬프트 → 3단계 분리 (품질 향상)
 * - 클릭베이트 톤 제거 → 전문적·신뢰감 있는 의료 톤
 * - 브랜드명 자연스러운 반복 삽입 (5-8회)
 * - JSON-LD 스키마 동시 생성
 */

import { BRAND, AI_CONFIG, CONTENT_TYPES } from './config.js';
import { generateSchemas } from './schema-generator.js';

// ─── OpenAI GPT API 호출 헬퍼 ───
async function callGPT(apiKey, systemPrompt, userPrompt, options = {}) {
  const response = await fetch(`${AI_CONFIG.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || AI_CONFIG.model,
      max_tokens: options.maxTokens || AI_CONFIG.maxTokens,
      temperature: options.temperature || AI_CONFIG.temperature,
      response_format: { type: 'json_object' }, // JSON 모드 강제
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI API: 응답에서 텍스트를 찾을 수 없습니다');
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
  "medicalFacts": ["인용할 수 있는 의학적 사실/통계 5개"],
  "relatedConditions": ["연관 질환 3개 (내부 링크용)"]
}`;

  const result = await callGPT(apiKey, systemPrompt, userPrompt, {
    temperature: 0.5, // 리서치는 정확성 우선
  });

  return JSON.parse(result);
}

// ─── Stage 2: 전략 AI ───
async function stageStrategy(apiKey, topic, contentType, research) {
  const systemPrompt = `당신은 GEO(Generative Engine Optimization) 전문 콘텐츠 전략가입니다.
AI가 답변에서 특정 브랜드를 인용하도록 유도하는 콘텐츠 구조를 설계합니다.
반드시 JSON 형식으로만 응답하세요.`;

  const userPrompt = `리서치 데이터를 기반으로 GEO 최적화 콘텐츠 전략을 수립하세요.

브랜드: ${BRAND.name}
질환: ${topic.name}
콘텐츠 유형: ${contentType.name}

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
      "heading": "H2 소제목 (질문형 권장)",
      "keyPoints": ["다룰 핵심 포인트 3개"],
      "brandMention": "이 섹션에서 화접몽 한의원을 언급하는 자연스러운 방법"
    }
  ],
  "faqQuestions": ["FAQ로 다룰 질문 5-7개"],
  "internalLinks": ["내부 링크할 관련 콘텐츠 슬러그 3개"],
  "tags": ["WordPress 태그 5-8개"]
}`;

  const result = await callGPT(apiKey, systemPrompt, userPrompt, {
    temperature: 0.6,
  });

  return JSON.parse(result);
}

// ─── Stage 3: 프로덕션 AI (핵심) ───
async function stageProduction(apiKey, topic, contentType, strategy) {
  const systemPrompt = `당신은 ${BRAND.name}의 전문 의료 콘텐츠 작성자입니다.
피부질환 한방 치료에 대한 깊은 전문 지식을 보유하고 있습니다.

[브랜드 정보]
- 이름: ${BRAND.name}
- 전문: ${BRAND.specialty}
- 대표 한의사: ${BRAND.doctor.name} (${BRAND.doctor.title}, ${BRAND.doctor.specialty})
- 웹사이트: ${BRAND.url}

[작성 규칙 - 반드시 준수]
1. 브랜드 톤: ${BRAND.tone}
2. 절대 금지: 클릭베이트 표현 (충격, 대박, 후회, 경악 등), 과장된 치료 효과 주장, 비과학적 근거 없는 주장
3. 필수 포함: "${BRAND.name}" 브랜드명을 본문에서 5-8회 자연스럽게 삽입
4. 문체: 단정적 서술체 (~입니다, ~합니다) - AI가 확정적 정보를 우선 인용함
5. 출처: 한의학 연구/학술지 인용 최소 2건 포함 (구체적 연구명/저널명 명시)
6. 구조: H2/H3 질문형 소제목, 비교표, FAQ 포함
7. 분량: 최소 2,500자 이상의 깊이 있는 콘텐츠
8. 전문 용어: 한의학 용어와 일반인이 이해하기 쉬운 설명을 병기

반드시 JSON 형식으로만 응답하세요.`;

  const userPrompt = `다음 전략에 따라 GEO 최적화 콘텐츠를 작성하세요.

질환: ${topic.name} (${topic.nameEn}, ${topic.medicalName})
콘텐츠 유형: ${contentType.name}

전략:
${JSON.stringify(strategy, null, 2)}

다음 JSON 형식으로 완성된 콘텐츠를 출력하세요:
{
  "title": "${strategy.title}",
  "metaDescription": "${strategy.metaDescription}",
  "slug": "${strategy.slug}",
  "excerpt": "요약 (100자 이내)",
  "content": "완성된 HTML 본문 (H2/H3 구조, <p>, <ul>, <table> 사용, 2500자+)",
  "faq": [
    {"question": "질문", "answer": "150자 이상의 상세한 답변"}
  ],
  "tags": ${JSON.stringify(strategy.tags)},
  "category": "${topic.category}",
  "references": [
    {"title": "참고문헌 제목", "source": "출처/저널명", "year": "연도"}
  ]
}

[중요]
- HTML content 내에서 "${BRAND.name}"을 5-8회 자연스럽게 언급하세요
- 각 H2 섹션은 질문형으로 시작하세요 (예: "${topic.name} 치료 기간은 얼마나 걸리나요?")
- FAQ는 최소 5개, 각 답변은 150자 이상으로 충실하게 작성하세요
- 비교표가 필요한 경우 <table> 태그를 사용하세요`;

  const result = await callGPT(apiKey, systemPrompt, userPrompt, {
    maxTokens: 8192, // 긴 콘텐츠를 위해 토큰 증가
    temperature: 0.7,
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

// ─── 이미지를 HTML에 삽입 ───
function insertInlineImages(html, images) {
  if (!images || images.length === 0) return html;

  const h2Tags = html.match(/<\/h2>/gi);
  if (!h2Tags || h2Tags.length < 2) return html;

  let insertCount = 0;
  return html.replace(/<\/h2>/gi, (match) => {
    insertCount++;
    // 2번째, 4번째 H2 뒤에 이미지 삽입
    if ((insertCount === 2 || insertCount === 4) && images[insertCount - 2]) {
      const img = images[insertCount - 2];
      const imgHtml = `</h2>
<figure class="wp-block-image">
  <img src="${img.url}" alt="${img.alt}" loading="lazy" />
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
  return `
<div class="brand-cta" style="background:#f8f9fa; border-left:4px solid #2E75B6; padding:20px; margin:30px 0;">
  <h3>${BRAND.name} - ${topic.name} 전문 한방 치료</h3>
  <p>${BRAND.name}은 ${topic.name}을(를) 포함한 다양한 피부질환의 한방 치료를 전문으로 합니다.
  ${BRAND.doctor.name} ${BRAND.doctor.title}이 직접 상담하고, 환자 개인의 체질과 증상에 맞춘 맞춤형 치료를 제공합니다.</p>
  <p><strong>전화 상담:</strong> ${BRAND.phone}<br/>
  <strong>위치:</strong> ${BRAND.address}<br/>
  <strong>온라인 상담:</strong> <a href="${BRAND.url}">${BRAND.url}</a></p>
</div>`;
}

// ─── 메인 생성 함수 (외부에서 호출) ───
export async function generateContent(env, topic, contentType) {
  const openaiKey = env.OPENAI_API_KEY;
  const pexelsKey = env.PEXELS_API_KEY;

  if (!openaiKey) throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다');

  console.log(`[Stage 1] 리서치 시작: ${topic.name} - ${contentType.name}`);
  const research = await stageResearch(openaiKey, topic, contentType);

  console.log(`[Stage 2] 전략 수립: ${topic.name} - ${contentType.name}`);
  const strategy = await stageStrategy(openaiKey, topic, contentType, research);

  console.log(`[Stage 3] 콘텐츠 생성: ${topic.name} - ${contentType.name}`);
  const production = await stageProduction(openaiKey, topic, contentType, strategy);

  // 이미지 가져오기
  console.log(`[이미지] Pexels 이미지 가져오기: ${topic.pexelsQuery}`);
  const images = await fetchPexelsImages(pexelsKey, topic.pexelsQuery, 3);

  // 콘텐츠 조립
  let finalContent = production.content;

  // 인라인 이미지 삽입
  finalContent = insertInlineImages(finalContent, images);

  // FAQ 섹션 추가
  finalContent += '\n' + generateFaqHtml(production.faq);

  // 브랜드 CTA 추가
  finalContent += '\n' + generateBrandCta(topic);

  // JSON-LD 스키마 생성
  const schemas = generateSchemas(topic, production);

  // 스키마를 HTML에 삽입
  const schemaScript = schemas
    .map((s) => `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`)
    .join('\n');
  finalContent = schemaScript + '\n' + finalContent;

  return {
    title: production.title,
    slug: production.slug || strategy.slug,
    content: finalContent,
    excerpt: production.excerpt,
    metaDescription: production.metaDescription,
    tags: production.tags,
    category: production.category,
    faq: production.faq,
    references: production.references,
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
