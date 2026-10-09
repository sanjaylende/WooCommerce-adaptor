<?php
defined('ABSPATH') || exit;

/**
 * Plugin log: wp-content/uploads/flipick-video-generator-logs/flipick-video-generator.log
 *
 * Rotated every day at 00:05:00 (site timezone) and at once when the file passes 10 MB; the old file is zipped and a new one
 * started (see FVG_Log_Rotator). The folder is closed to the web (.htaccess + index.php); logs are listed and downloaded from
 * WooCommerce > Video Generator. Context values whose key looks like a secret are redacted. Logging never throws.
 *
 * Filters: fvg_log_max_bytes (default 10485760), fvg_log_rotate_at (default "00:05"), fvg_log_retention_days (default 0 = keep).
 */
final class FVG_Logger {
    const SOURCE = 'flipick-video-generator';
    const CRON_HOOK = 'fvg_rotate_logs';

    /** @var FVG_Log_Rotator|null */
    private static $rotator = null;
    /** @var bool */
    private static $broken = false;

    public static function debug($message, array $context = []) { self::log('debug', $message, $context); }
    public static function info($message, array $context = []) { self::log('info', $message, $context); }
    public static function warning($message, array $context = []) { self::log('warning', $message, $context); }
    public static function error($message, array $context = []) { self::log('error', $message, $context); }

    public static function log($level, $message, array $context = []) {
        try {
            // Debug lines only when WP_DEBUG is on, so production logs stay quiet.
            if ($level === 'debug' && !(defined('WP_DEBUG') && WP_DEBUG)) {
                return;
            }
            $line = '[' . gmdate('Y-m-d H:i:s') . ' UTC] ' . strtoupper($level) . ' ' . $message;
            if ($context) {
                $line .= ' ' . wp_json_encode(self::redact($context));
            }
            $rotator = self::rotator();
            if ($rotator && $rotator->append($line . "\n")) {
                return;
            }
            // The log folder is not writable: fall back to PHP's error log rather than lose the message.
            error_log('[' . self::SOURCE . '] ' . $line);
        } catch (Throwable $e) {
            // Logging must never break the request.
        }
    }

    public static function directory() {
        $uploads = wp_upload_dir(null, false);
        return rtrim($uploads['basedir'], '/\\') . '/flipick-video-generator-logs';
    }

    /** @return FVG_Log_Rotator|null */
    public static function rotator() {
        if (self::$rotator || self::$broken) {
            return self::$rotator;
        }
        try {
            $dir = self::directory();
            if (!is_dir($dir) && !wp_mkdir_p($dir)) {
                self::$broken = true;
                return null;
            }
            self::protect($dir);
            self::$rotator = new FVG_Log_Rotator(
                $dir,
                self::SOURCE,
                (int) apply_filters('fvg_log_max_bytes', FVG_Log_Rotator::DEFAULT_MAX_BYTES),
                (string) apply_filters('fvg_log_rotate_at', FVG_Log_Rotator::DEFAULT_ROTATE_AT),
                wp_timezone(),
                (int) apply_filters('fvg_log_retention_days', 0)
            );
        } catch (Throwable $e) {
            self::$broken = true;
        }
        return self::$rotator;
    }

    /** Keeps the folder closed to the web: logs can hold URLs and ids. */
    private static function protect($dir) {
        if (!is_file($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess', "# Flipick Video Generator logs: not for the web\n<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");
        }
        if (!is_file($dir . '/index.php')) {
            @file_put_contents($dir . '/index.php', "<?php\n// Silence is golden.\n");
        }
    }

    /** Hooks the daily job: WP-Cron fires fvg_rotate_logs at the next 00:05:00 and schedules the following one. */
    public static function register_cron() {
        add_action(self::CRON_HOOK, [__CLASS__, 'run_scheduled_rotation']);
        add_action('init', [__CLASS__, 'ensure_scheduled']);
    }

    public static function ensure_scheduled() {
        try {
            if (wp_next_scheduled(self::CRON_HOOK)) {
                return;
            }
            $rotator = self::rotator();
            if ($rotator) {
                wp_schedule_single_event($rotator->nextBoundary(), self::CRON_HOOK);
            }
        } catch (Throwable $e) {
            // never fatal
        }
    }

    public static function run_scheduled_rotation() {
        try {
            $rotator = self::rotator();
            if ($rotator) {
                $archive = $rotator->rotateIfDue();
                if ($archive) {
                    self::info('Log rotated', ['archive' => basename($archive)]);
                }
                wp_schedule_single_event($rotator->nextBoundary(), self::CRON_HOOK);
            }
        } catch (Throwable $e) {
            error_log('[' . self::SOURCE . '] scheduled log rotation failed: ' . $e->getMessage());
        }
    }

    public static function clear_schedule() {
        wp_clear_scheduled_hook(self::CRON_HOOK);
    }

    private static function redact($value) {
        if (!is_array($value)) {
            return $value;
        }
        $out = [];
        foreach ($value as $k => $v) {
            $out[$k] = (is_string($k) && preg_match('/(secret|token|password|authorization|signature|consumer|credential|key|install)/i', $k)) ? '[redacted]' : self::redact($v);
        }
        return $out;
    }
}
