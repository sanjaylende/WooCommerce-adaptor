<?php
// Runs when the plugin is deleted from wp-admin. Tells the adapter (best effort), then removes every trace of the connection.
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

define('FLIPICK_VG_VERSION', '1.0.0');
define('FLIPICK_VG_FILE', __DIR__ . '/flipick-video-generator.php');
define('FLIPICK_VG_DIR', __DIR__ . '/');
require_once __DIR__ . '/includes/class-flipick-vg-log-rotator.php';
require_once __DIR__ . '/includes/class-flipick-vg-logger.php';
require_once __DIR__ . '/includes/class-flipick-vg-endpoints.php';
require_once __DIR__ . '/includes/class-flipick-vg-settings.php';
require_once __DIR__ . '/includes/class-flipick-vg-adapter-client.php';
require_once __DIR__ . '/includes/class-flipick-vg-connection.php';

try {
    if (Flipick_VG_Settings::is_connected() && class_exists('WooCommerce')) {
        Flipick_VG_Connection::disconnect();
    }
} catch (Throwable $e) {
    // Never block an uninstall.
}
delete_option(Flipick_VG_Settings::OPTION);
delete_transient('flipick_vg_video_states');
Flipick_VG_Logger::clear_schedule();
// The plugin's own log folder goes with it.
$flipick_vg_log_dir = Flipick_VG_Logger::directory();
if (is_dir($flipick_vg_log_dir)) {
    foreach ((array) scandir($flipick_vg_log_dir) as $flipick_vg_name) {
        if ($flipick_vg_name !== '.' && $flipick_vg_name !== '..' && is_file($flipick_vg_log_dir . '/' . $flipick_vg_name)) {
            wp_delete_file($flipick_vg_log_dir . '/' . $flipick_vg_name);
        }
    }
    // The (now empty) folder is removed through WP_Filesystem.
    require_once ABSPATH . 'wp-admin/includes/file.php';
    global $wp_filesystem;
    if (WP_Filesystem() && $wp_filesystem) {
        $wp_filesystem->rmdir($flipick_vg_log_dir, true);
    }
    if (is_dir($flipick_vg_log_dir)) {
        // Where WordPress would ask for FTP credentials (uninstall run by another system user than the web server) the folder is empty and inside uploads: remove it directly.
        @rmdir($flipick_vg_log_dir); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir, WordPress.PHP.NoSilencedErrors.Discouraged -- fallback for the empty folder of this plugin
    }
}
