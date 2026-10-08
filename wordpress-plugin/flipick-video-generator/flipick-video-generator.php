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

require_once FVG_DIR . 'includes/class-fvg-logger.php';
require_once FVG_DIR . 'includes/class-fvg-settings.php';
require_once FVG_DIR . 'includes/class-fvg-adapter-client.php';
require_once FVG_DIR . 'includes/class-fvg-connection.php';
require_once FVG_DIR . 'includes/class-fvg-admin.php';
require_once FVG_DIR . 'includes/class-fvg-storefront.php';

// HPOS (custom order tables) compatibility: the plugin never touches orders.
add_action('before_woocommerce_init', function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', FVG_FILE, true);
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
        (new FVG_Admin())->register();
        (new FVG_Storefront())->register();
    } catch (Throwable $e) {
        // A bug in this plugin must never white-screen the merchant's store.
        FVG_Logger::error('Plugin failed to start', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
    }
});

// Local development only: WordPress refuses requests (including WooCommerce webhook deliveries) to private or loopback hosts.
// On a 'local' environment the configured adapter host is allowed; production sites are unaffected.
add_filter('http_request_host_is_external', function ($external, $host) {
    if (!$external && function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) FVG_Settings::get('adapter_url'), PHP_URL_HOST);
        return $adapter && strtolower($adapter) === strtolower($host) ? true : $external;
    }
    return $external;
}, 10, 2);

// WordPress's "safe" requests only allow ports 80, 443 and 8080; a local adapter listens elsewhere (4300).
add_filter('http_allowed_safe_ports', function ($ports, $host) {
    if (function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        $adapter = wp_parse_url((string) FVG_Settings::get('adapter_url'));
        if (!empty($adapter['host']) && strtolower($adapter['host']) === strtolower($host) && !empty($adapter['port'])) {
            $ports[] = (int) $adapter['port'];
        }
    }
    return $ports;
}, 10, 2);

register_deactivation_hook(__FILE__, function () {
    FVG_Logger::info('Plugin deactivated');
});
