/**
 * 환경변수 객체 (WordPress, Gemini 등 외부 API용)
 * 런타임에 DB에서 로드한 이미지 API 키도 여기에 병합됨
 */
export const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinic.blog',
  WP_AUTH_KEY: process.env.WP_AUTH_KEY,
  WP_REST_USER: process.env.WP_REST_USER,
  WP_REST_PASS: process.env.WP_REST_PASS,
  PIXABAY_API_KEY: process.env.PIXABAY_API_KEY,
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
  INDEXNOW_API_KEY: process.env.INDEXNOW_API_KEY,
};
