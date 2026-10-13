<?php
/**
 * Plugin Name:       Flipick Video Generator for WooCommerce
 * Description:       Generate product videos with Flipick and show them on your product pages. Connects this store to the Flipick video adapter.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * Author:            Flipick
 * License:           GPL-2.0-or-later
 * Text Domain:       flipick-video-generator
 *
 * WC requires at least: 8.0
 */

defined('ABSPATH') || exit;

define('FVG_VERSION', '1.0.0');
define('FVG_FILE', __FILE__);
define('FVG_DIR', plugin_dir_path(__FILE__));

// The two product meta keys the adapter writes through the WooCommerce REST API and this plugin reads on the storefront.
define('FVG_META_VIDEO_URL', '_flipick_video_url');
define('FVG_META_VIDEO_THUMB', '_flipick_video_thumb');

// Classes are loaded when first used: a front-end request needs none of the admin, connection or adapter code, and most pages need no
// plugin class at all.
spl_autoload_register(function ($class) {
    static $files = [
        'FVG_Log_Rotator' => 'class-fvg-log-rotator.php',
        'FVG_Logger' => 'class-fvg-logger.php',
        'FVG_Endpoints' => 'class-fvg-endpoints.php',
        'FVG_Settings' => 'class-fvg-settings.php',
        'FVG_Adapter_Client' => 'class-fvg-adapter-client.php',
        'FVG_Connection' => 'class-fvg-connection.php',
        'FVG_Admin' => 'class-fvg-admin.php',
        'FVG_Storefront' => 'class-fvg-storefront.php',
    ];
    if (isset($files[$class])) {
        require_once FVG_DIR . 'includes/' . $files[$class];
    }
});

// HPOS (custom order tables) compatibility: the plugin never touches orders. WooCommerce reads this declaration only in the admin (the
// Features screen and the plugin list; WP-CLI's HPOS commands check it too), and recording it costs about 17 ms on every request, so it is made
// where it is read.
add_action('before_woocommerce_init', function () {
    if ((is_admin() || (defined('WP_CLI') && WP_CLI)) && class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', FVG_FILE, true);
    }
});

// Daily 00:05 log rotation (WP-Cron), independent of WooCommerce being active. The logger class is loaded only when the job fires or when the
// job is missing and has to be scheduled again.
add_action('fvg_rotate_logs', function () {
    FVG_Logger::run_scheduled_rotation();
});
add_action('init', function () {
    if (!wp_next_scheduled('fvg_rotate_logs')) {
        FVG_Logger::ensure_scheduled();
    }
});

add_action('plugins_loaded', function () {
    try {
        if (!class_exists('WooCommerce')) {
            add_action('admin_notices', function () {
                echo '<div class="notice notice-error"><p>' . esc_html__('Flipick Video Generator needs WooCommerce to be active.', 'flipick-video-generator') . '</p></div>';
            });
            FVG_Logger::warning('WooCommerce is not active; plugin idle');
            return;
        }
        if (is_admin()) {
            (new FVG_Admin())->register();
        }
        // The storefront class is created when a product page (or the shortcode) actually renders a video.
        add_action('woocommerce_after_single_product_summary', function () {
            (new FVG_Storefront())->render_current();
        }, 5);
        add_shortcode('flipick_video', function ($atts) {
            return (new FVG_Storefront())->shortcode($atts);
        });
    } catch (Throwable $e) {
        // A bug in this plugin must never white-screen the merchant's store.
        FVG_Logger::error('Plugin failed to start', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
    }
});

// Local development only: WordPress refuses requests (including WooCommerce webhook deliveries) to private or loopback hosts.
// On a 'local' environment the configured adapter host is allowed; production sites are unaffected.
add_filter('http_request_host_is_external', function ($external, $host) {
    if (!$external && function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) FVG_Settings::adapter_url(), PHP_URL_HOST);
        return $adapter && strtolower($adapter) === strtolower($host) ? true : $external;
    }
    return $external;
}, 10, 2);

// WordPress's "safe" requests only allow ports 80, 443 and 8080; a local adapter listens elsewhere (4300).
add_filter('http_allowed_safe_ports', function ($ports, $host) {
    if (function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) FVG_Settings::adapter_url());
        if (!empty($adapter['host']) && strtolower($adapter['host']) === strtolower($host) && !empty($adapter['port'])) {
            $ports[] = (int) $adapter['port'];
        }
    }
    return $ports;
}, 10, 2);

register_deactivation_hook(__FILE__, function () {
    FVG_Logger::info('Plugin deactivated');
    FVG_Logger::clear_schedule();
});
