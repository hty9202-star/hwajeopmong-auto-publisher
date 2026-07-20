<?php
/**
 * 화접몽 — JSON-LD 스키마를 글 <head>에 출력
 *
 * 발행 시 _hwj_jsonld 메타(JSON 배열)에 저장된 의료 스키마(MedicalCondition,
 * MedicalWebPage, MedicalBusiness, FAQPage)를 단일 글 페이지의 <head>에 출력한다.
 *
 * 설치 위치(권장): Hwajeopmong WP Bridge 플러그인의 메인 PHP 파일 하단에 추가.
 *  - Bridge 플러그인은 PHP가 정상 실행되므로 가장 확실하다.
 *  - 또는 자식 테마 functions.php / Code Snippets(실행되는 경우)에 추가해도 동일하게 동작.
 *
 * 안전: 우리가 생성한 신뢰된 JSON만 wp_json_encode로 출력. 외부 입력 없음.
 */
add_action('wp_head', function () {
    if (!is_singular('post')) {
        return;
    }
    $jsonld = get_post_meta(get_the_ID(), '_hwj_jsonld', true);
    if (empty($jsonld)) {
        return;
    }
    $schemas = json_decode($jsonld, true);
    if (!is_array($schemas)) {
        return;
    }
    foreach ($schemas as $schema) {
        if (!is_array($schema)) {
            continue;
        }
        echo "\n" . '<script type="application/ld+json">'
            . wp_json_encode($schema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            . '</script>';
    }
}, 20);
