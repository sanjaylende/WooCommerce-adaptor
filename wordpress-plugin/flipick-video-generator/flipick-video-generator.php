<?php
/**
 * Plugin Name:       Flipick Video Generator for WooCommerce
 * Plugin URI:         https://flipick.com/
 * Description:       Generate product videos for your WooCommerce products with the Flipick video service and show them on your product pages.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * Author:            Flipick
 * Author URI:        https://flipick.com/
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       flipick-video-generator
 *
 * WC requires at least: 8.0
 */

defined('ABSPATH') || exit;

define('FLIPICK_VG_VERSION', '1.0.0');
define('FLIPICK_VG_FILE', __FILE__);
define('FLIPICK_VG_DIR', plugin_dir_path(__FILE__));

// The two product meta keys the adapter writes through the WooCommerce REST API and this plugin reads on the storefront.
define('FLIPICK_VG_META_VIDEO_URL', '_flipick_video_url');
define('FLIPICK_VG_META_VIDEO_THUMB', '_flipick_video_thumb');

// Classes are loaded when first used: a front-end request needs none of the admin, connection or adapter code, and most pages need no
// plugin class at all.
spl_autoload_register(function ($class) {
    static $files = [
        'Flipick_VG_Log_Rotator' => 'class-flipick-vg-log-rotator.php',
        'Flipick_VG_Logger' => 'class-flipick-vg-logger.php',
        'Flipick_VG_Endpoints' => 'class-flipick-vg-endpoints.php',
        'Flipick_VG_Settings' => 'class-flipick-vg-settings.php',
        'Flipick_VG_Adapter_Client' => 'class-flipick-vg-adapter-client.php',
        'Flipick_VG_Connection' => 'class-flipick-vg-connection.php',
        'Flipick_VG_Admin' => 'class-flipick-vg-admin.php',
        'Flipick_VG_Storefront' => 'class-flipick-vg-storefront.php',
    ];
    if (isset($files[$class])) {
        require_once FLIPICK_VG_DIR . 'includes/' . $files[$class];
    }
});

// HPOS (custom order tables) compatibility: the plugin never touches orders. WooCommerce reads this declaration only in the admin (the
// Features screen and the plugin list; WP-CLI's HPOS commands check it too), and recording it costs about 17 ms on every request, so it is made
// where it is read.
add_action('before_woocommerce_init', function () {
    if ((is_admin() || (defined('WP_CLI') && WP_CLI)) && class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', FLIPICK_VG_FILE, true);
    }
});

// Daily 00:05 log rotation (WP-Cron), independent of WooCommerce being active. The logger class is loaded only when the job fires or when the
// job is missing and has to be scheduled again.
add_action('flipick_vg_rotate_logs', function () {
    Flipick_VG_Logger::run_scheduled_rotation();
});
add_action('init', function () {
    if (!wp_next_scheduled('flipick_vg_rotate_logs')) {
        Flipick_VG_Logger::ensure_scheduled();
    }
});

add_action('plugins_loaded', function () {
    try {
        if (!class_exists('WooCommerce')) {
            add_action('admin_notices', function () {
                echo '<div class="notice notice-error"><p>' . esc_html__('Flipick Video Generator needs WooCommerce to be active.', 'flipick-video-generator') . '</p></div>';
            });
            Flipick_VG_Logger::warning('WooCommerce is not active; plugin idle');
            return;
        }
        if (is_admin()) {
            (new Flipick_VG_Admin())->register();
        }
        // The storefront class is created when a product page (or the shortcode) actually renders a video.
        add_action('woocommerce_after_single_product_summary', function () {
            (new Flipick_VG_Storefront())->render_current();
        }, 5);
        add_shortcode('flipick_video', function ($atts) {
            return (new Flipick_VG_Storefront())->shortcode($atts);
        });
    } catch (Throwable $e) {
        // A bug in this plugin must never white-screen the merchant's store.
        Flipick_VG_Logger::error('Plugin failed to start', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
    }
});

/** True only when a developer defined FLIPICK_ADAPTER_URL / FLIPICK_ADAPTER_SERVER_URL in wp-config.php; a site installed from the directory never has them. */
function flipick_vg_is_developer_override() {
    return defined('FLIPICK_ADAPTER_URL') || defined('FLIPICK_ADAPTER_SERVER_URL');
}

// Local development only (both filters below act only when the override above is defined AND the environment type is 'local'): WordPress refuses requests (including WooCommerce webhook deliveries) to private or loopback hosts.
// On a 'local' environment the configured adapter host is allowed; production sites are unaffected.
add_filter('http_request_host_is_external', function ($external, $host) {
    if (!$external && flipick_vg_is_developer_override() && function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) Flipick_VG_Settings::adapter_url(), PHP_URL_HOST);
        return $adapter && strtolower($adapter) === strtolower($host) ? true : $external;
    }
    return $external;
}, 10, 2);

// WordPress's "safe" requests only allow ports 80, 443 and 8080; a local adapter listens elsewhere (4300).
add_filter('http_allowed_safe_ports', function ($ports, $host) {
    if (flipick_vg_is_developer_override() && function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) Flipick_VG_Settings::adapter_url());
        if (!empty($adapter['host']) && strtolower($adapter['host']) === strtolower($host) && !empty($adapter['port'])) {
            $ports[] = (int) $adapter['port'];
        }
    }
    return $ports;
}, 10, 2);

register_deactivation_hook(__FILE__, function () {
    Flipick_VG_Logger::info('Plugin deactivated');
    Flipick_VG_Logger::clear_schedule();
});
