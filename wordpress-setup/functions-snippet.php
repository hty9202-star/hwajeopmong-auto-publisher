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

// ─── 2. JSON-LD 스키마가 wp_kses에서 제거되지 않도록 허용 ───
add_filter('wp_kses_allowed_html', function($allowed, $context) {
    if ($context === 'post') {
        $allowed['script'] = array(
            'type' => true,
        );
    }
    return $allowed;
}, 10, 2);

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
