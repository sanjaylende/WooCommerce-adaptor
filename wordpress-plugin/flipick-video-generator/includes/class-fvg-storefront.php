<?php
defined('ABSPATH') || exit;

/** Shows the published video on the product page (and through the [flipick_video] shortcode). */
final class FVG_Storefront {
    public function register() {
        add_action('woocommerce_after_single_product_summary', [$this, 'render_current'], 5);
        add_shortcode('flipick_video', [$this, 'shortcode']);
    }

    public function render_current() {
        echo $this->markup(get_the_ID()); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped in markup()
    }

    public function shortcode($atts) {
        $atts = shortcode_atts(['id' => 0], $atts, 'flipick_video');
        return $this->markup((int) $atts['id'] ?: get_the_ID());
    }

    private function markup($product_id) {
        try {
            // The shortcode takes any id: never reveal the video of a draft, private or password-protected product.
            if (get_post_status($product_id) !== 'publish' && !current_user_can('read_post', $product_id)) {
                return '';
            }
            if (post_password_required($product_id)) {
                return '';
            }
            $url = (string) get_post_meta($product_id, FVG_META_VIDEO_URL, true);
            // Only absolute http(s) URLs: the meta is written through the REST API, never trusted as markup.
            if ($url === '' || !wp_http_validate_url($url) || !in_array(wp_parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true)) {
                return '';
            }
            $thumb = (string) get_post_meta($product_id, FVG_META_VIDEO_THUMB, true);
            $poster = ($thumb !== '' && wp_http_validate_url($thumb)) ? ' poster="' . esc_url($thumb) . '"' : '';
            return '<div class="fvg-video" style="margin:0 0 2em;max-width:100%"><video controls playsinline preload="metadata" style="width:100%;height:auto"'
                . $poster . ' src="' . esc_url($url) . '"></video></div>';
        } catch (Throwable $e) {
            FVG_Logger::error('Storefront video failed to render', ['product' => $product_id, 'error' => $e->getMessage()]);
            return '';
        }
    }
}
