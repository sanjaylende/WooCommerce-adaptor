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

    /**
     * An absolute http(s) address with a host and no credentials; an IP-address host must be a public one. This is checked without any network
     * call: wp_http_validate_url() resolves the host name through DNS on every call (about 10 ms each, twice per product page), and here the
     * address is only printed into the page for the visitor's browser, never fetched by the server.
     */
    private static function is_http_url($url) {
        $parts = wp_parse_url($url);
        if (!is_array($parts) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            return false;
        }
        if (!in_array(strtolower((string) ($parts['scheme'] ?? '')), ['http', 'https'], true)) {
            return false;
        }
        $host = trim($parts['host'], '[]');
        if (strtolower($host) === 'localhost') {
            return false;
        }
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
        }
        return true;
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
            if ($url === '' || !self::is_http_url($url)) {
                return '';
            }
            $thumb = (string) get_post_meta($product_id, FVG_META_VIDEO_THUMB, true);
            $poster = ($thumb !== '' && self::is_http_url($thumb)) ? ' poster="' . esc_url($thumb) . '"' : '';
            return '<div class="fvg-video" style="margin:0 0 2em;max-width:100%"><video controls playsinline preload="metadata" style="width:100%;height:auto"'
                . $poster . ' src="' . esc_url($url) . '"></video></div>';
        } catch (Throwable $e) {
            FVG_Logger::error('Storefront video failed to render', ['product' => $product_id, 'error' => $e->getMessage()]);
            return '';
        }
    }
}
