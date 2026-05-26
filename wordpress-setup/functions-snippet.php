<?php
/**
 * 화접몽 한의원 WordPress functions.php 추가 코드
 * 테마의 functions.php 하단에 추가하거나, Code Snippets 플러그인으로 삽입
 */

// ─── 1. llms.txt 라우팅 (AI 크롤러용) ───
add_action('init', function() {
    add_rewrite_rule('^llms\.txt$', 'index.php?llms_txt=1', 'top');
});
add_filter('query_vars', function($vars) {
    $vars[] = 'llms_txt';
    return $vars;
});
add_action('template_redirect', function() {
    if (get_query_var('llms_txt')) {
        header('Content-Type: text/plain; charset=utf-8');
        $file = ABSPATH . 'llms.txt';
        if (file_exists($file)) {
            readfile($file);
        } else {
            echo '# 화접몽 한의원 - llms.txt not found';
        }
        exit;
    }
});

// ─── 2. JSON-LD 스키마를 <head>에 자동 출력 (커스텀 메타 _hwj_jsonld 기반) ───
add_action('wp_head', function() {
    if (!is_singular('post')) return;
    $jsonld = get_post_meta(get_the_ID(), '_hwj_jsonld', true);
    if (empty($jsonld)) return;
    $schemas = json_decode($jsonld, true);
    if (!is_array($schemas)) return;
    foreach ($schemas as $schema) {
        echo '<script type="application/ld+json">' . wp_json_encode($schema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '</script>' . "\n";
    }
}, 1);

// _hwj_jsonld 메타 필드를 REST API에서 저장 가능하도록 등록
add_action('init', function() {
    register_post_meta('post', '_hwj_jsonld', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
});

// Yoast SEO 메타 필드 등록 (포커스 키프레이즈, 제목, 메타설명)
add_action('init', function() {
    register_post_meta('post', '_yoast_wpseo_focuskw', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
    register_post_meta('post', '_yoast_wpseo_title', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
    register_post_meta('post', '_yoast_wpseo_metadesc', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
});

// ─── 3. REST API 메타 필드 등록 (RankMath 호환) ───
add_action('init', function() {
    register_post_meta('post', 'rank_math_title', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
    register_post_meta('post', 'rank_math_description', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
    register_post_meta('post', 'rank_math_focus_keyword', [
        'show_in_rest' => true,
        'single' => true,
        'type' => 'string',
        'auth_callback' => function() { return current_user_can('edit_posts'); }
    ]);
});

// ─── 4. AI 크롤러 식별 로깅 (선택사항) ───
add_action('init', function() {
    if (!is_admin()) {
        $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $ai_bots = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];
        foreach ($ai_bots as $bot) {
            if (stripos($ua, $bot) !== false) {
                error_log("[AI Crawler] {$bot} visited: " . $_SERVER['REQUEST_URI']);
                break;
            }
        }
    }
});
