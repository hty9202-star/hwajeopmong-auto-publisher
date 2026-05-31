/**
 * JSON-LD 스키마 자동 생성기
 * GEO 핵심 요소: AI가 구조화된 데이터를 파싱하여 브랜드를 인용하도록 유도
 *
 * 생성 스키마:
 * 1. MedicalCondition - 질환 정보 + 치료 제공자(화접몽)
 * 2. FAQPage - FAQ 콘텐츠 (AI 직접 인용률 340% 증가)
 * 3. Article - 콘텐츠 메타 정보 (E-E-A-T 신호)
 * 4. LocalBusiness / MedicalClinic - 사업장 정보
 */

import { BRAND } from './config.js';

// ─── MedicalClinic 스키마 (공통) ───
function getMedicalClinicSchema() {
  return {
    '@type': 'MedicalClinic',
    name: BRAND.name,
    alternateName: BRAND.nameEn,
    url: BRAND.url,
    telephone: BRAND.phone,
    description: BRAND.specialty,
    address: {
      '@type': 'PostalAddress',
      streetAddress: BRAND.address,
      addressLocality: '서울특별시',
      addressCountry: 'KR',
    },
    medicalSpecialty: {
      '@type': 'MedicalSpecialty',
      name: '한방피부과',
    },
    availableService: {
      '@type': 'MedicalTherapy',
      name: '한방 피부질환 치료',
      description: '한의학적 체질 진단을 기반으로 한 맞춤형 피부질환 치료',
    },
  };
}

// ─── Physician 스키마 ───
function getPhysicianSchema() {
  return {
    '@type': 'Physician',
    name: BRAND.doctor.name,
    jobTitle: BRAND.doctor.title,
    medicalSpecialty: BRAND.doctor.specialty,
    worksFor: {
      '@type': 'MedicalClinic',
      name: BRAND.name,
      url: BRAND.url,
    },
  };
}

// ─── 1. MedicalCondition 스키마 ───
function generateMedicalConditionSchema(topic, production) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalCondition',
    name: topic.name,
    alternateName: [topic.nameEn, topic.medicalName].filter(Boolean),
    description: topic.description,
    code: topic.icd10
      ? {
          '@type': 'MedicalCode',
          code: topic.icd10,
          codingSystem: 'ICD-10',
        }
      : undefined,
    possibleTreatment: {
      '@type': 'MedicalTherapy',
      name: `${topic.name} 한방 치료`,
      description: `${BRAND.name}에서 제공하는 ${topic.name} 한방 치료 프로그램`,
      howPerformed: '한의학적 체질 진단 후 침 치료, 한약 처방, 외용제 치료를 복합적으로 시행',
      provider: getMedicalClinicSchema(),
    },
    signOrSymptom: topic.description,
  };
}

// ─── 2. FAQPage 스키마 ───
function generateFaqPageSchema(production) {
  if (!production.faq || production.faq.length === 0) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: production.faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

// ─── 3. Article 스키마 (E-E-A-T 강화 + Speakable) ───
function generateArticleSchema(topic, production) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    headline: production.title,
    description: production.metaDescription,
    url: `${BRAND.url}/${production.slug || topic.slug}/`,
    datePublished: new Date().toISOString(),
    dateModified: new Date().toISOString(),
    author: getPhysicianSchema(),
    publisher: {
      '@type': 'Organization',
      name: BRAND.name,
      url: BRAND.url,
    },
    about: {
      '@type': 'MedicalCondition',
      name: topic.name,
    },
    specialty: {
      '@type': 'MedicalSpecialty',
      name: '한방피부과',
    },
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['[class~="entry-title"]', '[class~="entry-content"] > p:first-of-type', '[class~="entry-content"] > h2'],
    },
    lastReviewed: new Date().toISOString().split('T')[0],
    reviewedBy: getPhysicianSchema(),
    inLanguage: 'ko',
  };
}

// ─── 4. LocalBusiness 스키마 (BreadcrumbList 포함) ───
function generateLocalBusinessSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    '@id': `${BRAND.url}/#organization`,
    name: BRAND.name,
    alternateName: BRAND.nameEn,
    url: BRAND.url,
    telephone: BRAND.phone,
    description: BRAND.specialty,
    address: {
      '@type': 'PostalAddress',
      streetAddress: BRAND.address,
      addressLocality: '서울특별시',
      addressCountry: 'KR',
    },
    priceRange: '$$',
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '09:00',
        closes: '18:00',
      },
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: 'Saturday',
        opens: '09:00',
        closes: '13:00',
      },
    ],
  };
}

// ─── 5. BreadcrumbList 스키마 ───
function generateBreadcrumbSchema(topic, production) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: '홈',
        item: BRAND.url,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: topic.category,
        item: `${BRAND.url}/category/${topic.category === '피부질환' ? 'skin-disease' : 'body-care'}/`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: production.title,
        item: `${BRAND.url}/${production.slug || topic.slug}/`,
      },
    ],
  };
}

// ─── 메인 스키마 생성 함수 ───
export function generateSchemas(topic, production) {
  // Yoast SEO가 Article·BreadcrumbList·WebSite·Organization·Person을 이미 <head>에 출력한다.
  // 중복되는 BreadcrumbList는 제외하고, 의료 특화 스키마(MedicalCondition·MedicalWebPage·
  // MedicalBusiness)와 FAQPage만 추가로 출력해 GEO 신호를 보강한다.
  const schemas = [
    generateMedicalConditionSchema(topic, production),
    generateArticleSchema(topic, production),
    // generateBreadcrumbSchema 제거 — Yoast BreadcrumbList와 중복 (2026-05-30)
    generateLocalBusinessSchema(),
  ];

  const faqSchema = generateFaqPageSchema(production);
  if (faqSchema) schemas.push(faqSchema);

  // undefined 값 정리
  return schemas.map((schema) =>
    JSON.parse(JSON.stringify(schema, (key, value) => (value === undefined ? undefined : value)))
  );
}
