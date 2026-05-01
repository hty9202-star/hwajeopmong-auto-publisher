/**
 * Supabase 클라이언트 모듈
 * 파일 기반 KV 저장소를 대체하는 PostgreSQL 연동
 *
 * 환경변수:
 * - SUPABASE_URL: https://vqoxcfanflbvxopvdgdj.supabase.co
 * - SUPABASE_ANON_KEY: Supabase anon key
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vqoxcfanflbvxopvdgdj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

// ─── Supabase REST API 헬퍼 ───
async function supabaseRequest(table, options = {}) {
  const { method = 'GET', query = '', body = null, headers: extraHeaders = {}, single = false, countOnly = false } = options;

  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    ...extraHeaders,
  };

  if (single) {
    headers['Accept'] = 'application/vnd.pgrst.object+json';
  }
  if (countOnly) {
    headers['Prefer'] = 'count=exact';
    headers['Range-Unit'] = 'items';
    headers['Range'] = '0-0';
  }

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase error [${response.status}]: ${error}`);
  }

  if (countOnly) {
    const contentRange = response.headers.get('content-range');
    const total = contentRange ? parseInt(contentRange.split('/')[1]) : 0;
    return total;
  }

  // DELETE나 204 응답은 빈 결과
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

// ─── Content Queue CRUD ───
export const contentQueue = {
  // 전체 조회 (최신순)
  async getAll() {
    return supabaseRequest('content_queue', {
      query: '?order=created_at.desc',
    });
  },

  // 상태별 조회
  async getByStatus(status) {
    return supabaseRequest('content_queue', {
      query: `?status=eq.${status}&order=created_at.desc`,
    });
  },

  // 단건 조회
  async getById(id) {
    return supabaseRequest('content_queue', {
      query: `?id=eq.${id}`,
      single: true,
    });
  },

  // 제목으로 조회
  async getByTitle(title) {
    return supabaseRequest('content_queue', {
      query: `?title=eq.${encodeURIComponent(title)}`,
      single: true,
    });
  },

  // 새 콘텐츠 추가
  async add(item) {
    return supabaseRequest('content_queue', {
      method: 'POST',
      body: item,
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 상태 업데이트
  async updateStatus(id, status, extra = {}) {
    return supabaseRequest('content_queue', {
      method: 'PATCH',
      query: `?id=eq.${id}`,
      body: { status, ...extra },
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 페이지네이션 + 검색 + 필터 조회
  async search({ page = 1, limit = 10, search = '', status = '', topic = '', sort = 'latest' } = {}) {
    const filters = [];
    if (status) filters.push(`status=eq.${status}`);
    if (topic) filters.push(`topic_id=eq.${topic}`);
    if (search) filters.push(`title=ilike.*${encodeURIComponent(search)}*`);

    const order = sort === 'oldest' ? 'created_at.asc' : 'created_at.desc';
    filters.push(`order=${order}`);

    const offset = (page - 1) * limit;
    filters.push(`offset=${offset}`);
    filters.push(`limit=${limit}`);

    const query = '?' + filters.join('&');

    // 데이터 조회
    const data = await supabaseRequest('content_queue', { query });

    // 전체 개수 조회 (페이지네이션용)
    const countFilters = [];
    if (status) countFilters.push(`status=eq.${status}`);
    if (topic) countFilters.push(`topic_id=eq.${topic}`);
    if (search) countFilters.push(`title=ilike.*${encodeURIComponent(search)}*`);
    const countQuery = countFilters.length > 0 ? '?' + countFilters.join('&') : '';

    const total = await supabaseRequest('content_queue', { query: countQuery, countOnly: true });

    return {
      data: data || [],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },

  // 상태별 카운트 (통계용)
  async getCounts() {
    const all = await supabaseRequest('content_queue', { query: '?select=status' });
    const counts = { pending: 0, approved: 0, rejected: 0, published: 0, total: 0 };
    for (const item of (all || [])) {
      counts[item.status] = (counts[item.status] || 0) + 1;
      counts.total++;
    }
    return counts;
  },

  // 삭제
  async delete(id) {
    return supabaseRequest('content_queue', {
      method: 'DELETE',
      query: `?id=eq.${id}`,
    });
  },
};

// ─── Publish Logs CRUD ───
export const publishLogs = {
  // 최근 로그 조회
  async getRecent(limit = 100) {
    return supabaseRequest('publish_logs', {
      query: `?order=created_at.desc&limit=${limit}`,
    });
  },

  // 페이지네이션 + 검색 조회
  async search({ page = 1, limit = 10, search = '', status = '', sort = 'latest' } = {}) {
    const filters = [];
    if (status) filters.push(`status=eq.${status}`);
    if (search) filters.push(`title=ilike.*${encodeURIComponent(search)}*`);

    const order = sort === 'oldest' ? 'created_at.asc' : 'created_at.desc';
    filters.push(`order=${order}`);

    const offset = (page - 1) * limit;
    filters.push(`offset=${offset}`);
    filters.push(`limit=${limit}`);

    const query = '?' + filters.join('&');
    const data = await supabaseRequest('publish_logs', { query });

    const countFilters = [];
    if (status) countFilters.push(`status=eq.${status}`);
    if (search) countFilters.push(`title=ilike.*${encodeURIComponent(search)}*`);
    const countQuery = countFilters.length > 0 ? '?' + countFilters.join('&') : '';
    const total = await supabaseRequest('publish_logs', { query: countQuery, countOnly: true });

    return {
      data: data || [],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },


  // 로그 추가
  async add(log) {
    return supabaseRequest('publish_logs', {
      method: 'POST',
      body: log,
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 제목으로 찾아서 업데이트
  async updateByTitle(title, updates) {
    return supabaseRequest('publish_logs', {
      method: 'PATCH',
      query: `?title=eq.${encodeURIComponent(title)}`,
      body: updates,
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // queue_id로 찾아서 업데이트
  async updateByQueueId(queueId, updates) {
    return supabaseRequest('publish_logs', {
      method: 'PATCH',
      query: `?queue_id=eq.${queueId}`,
      body: updates,
      headers: { 'Prefer': 'return=representation' },
    });
  },
};

// ─── Published Topics CRUD ───
export const publishedTopics = {
  // 전체 조회
  async getAll() {
    return supabaseRequest('published_topics', {
      query: '?select=combo_id',
    });
  },

  // combo_id 목록 반환 (기존 호환)
  async getComboIds() {
    const rows = await this.getAll();
    return (rows || []).map(r => r.combo_id);
  },

  // 추가 (중복 무시)
  async add(comboId, topicId, contentTypeId) {
    try {
      return await supabaseRequest('published_topics', {
        method: 'POST',
        body: { combo_id: comboId, topic_id: topicId, content_type_id: contentTypeId },
        headers: { 'Prefer': 'return=representation,resolution=ignore-duplicates' },
      });
    } catch (e) {
      // 중복 에러 무시
      if (e.message.includes('409') || e.message.includes('duplicate')) return null;
      throw e;
    }
  },
};

// ─── Topics CRUD (질환 관리) ───
export const topics = {
  // 전체 조회 (활성 + 정렬순)
  async getAll(includeInactive = false) {
    const filter = includeInactive ? '' : '&is_active=eq.true';
    return supabaseRequest('topics', {
      query: `?order=sort_order.asc${filter}`,
    });
  },

  // 단건 조회
  async getById(id) {
    return supabaseRequest('topics', {
      query: `?id=eq.${id}`,
      single: true,
    });
  },

  // 추가
  async add(topic) {
    return supabaseRequest('topics', {
      method: 'POST',
      body: topic,
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 수정
  async update(id, updates) {
    updates.updated_at = new Date().toISOString();
    return supabaseRequest('topics', {
      method: 'PATCH',
      query: `?id=eq.${id}`,
      body: updates,
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 삭제 (soft delete - 비활성화)
  async deactivate(id) {
    return supabaseRequest('topics', {
      method: 'PATCH',
      query: `?id=eq.${id}`,
      body: { is_active: false, updated_at: new Date().toISOString() },
      headers: { 'Prefer': 'return=representation' },
    });
  },

  // 완전 삭제
  async delete(id) {
    return supabaseRequest('topics', {
      method: 'DELETE',
      query: `?id=eq.${id}`,
    });
  },

  // 순서 일괄 업데이트
  async updateOrder(orderList) {
    // orderList: [{id, sort_order}, ...]
    for (const item of orderList) {
      await supabaseRequest('topics', {
        method: 'PATCH',
        query: `?id=eq.${item.id}`,
        body: { sort_order: item.sort_order },
      });
    }
  },
};

// ─── Settings CRUD ───
export const settings = {
  // 설정 조회
  async get(key) {
    try {
      const result = await supabaseRequest('settings', {
        query: `?key=eq.${key}`,
        single: true,
      });
      return result ? result.value : null;
    } catch {
      return null;
    }
  },

  // 설정 저장 (upsert)
  async set(key, value) {
    return supabaseRequest('settings', {
      method: 'POST',
      body: { key, value },
      headers: { 'Prefer': 'return=representation,resolution=merge-duplicates' },
    });
  },
};

// ─── 연결 테스트 ───
export async function testConnection() {
  try {
    if (!SUPABASE_KEY) return { connected: false, error: 'SUPABASE_ANON_KEY 미설정' };
    await supabaseRequest('settings', { query: '?limit=1' });
    return { connected: true, url: SUPABASE_URL };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}
