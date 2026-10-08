<?php
// Runs when the plugin is deleted from wp-admin. Tells the adapter (best effort), then removes every trace of the connection.
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

define('FVG_VERSION', '1.0.0');
define('FVG_FILE', __DIR__ . '/flipick-video-generator.php');
define('FVG_DIR', __DIR__ . '/');
require_once __DIR__ . '/includes/class-fvg-logger.php';
require_once __DIR__ . '/includes/class-fvg-settings.php';
require_once __DIR__ . '/includes/class-fvg-adapter-client.php';
require_once __DIR__ . '/includes/class-fvg-connection.php';

try {
    if (FVG_Settings::is_connected() && class_exists('WooCommerce')) {
        FVG_Connection::disconnect();
    }
} catch (Throwable $e) {
    // Never block an uninstall.
}
delete_option(FVG_Settings::OPTION);
