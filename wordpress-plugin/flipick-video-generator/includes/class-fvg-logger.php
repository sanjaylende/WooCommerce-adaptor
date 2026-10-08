<?php
defined('ABSPATH') || exit;

/**
 * Logging through WooCommerce's logger (WooCommerce > Status > Logs, source "flipick-video-generator"), falling back to
 * error_log. Context values whose key looks like a secret are redacted, so a log can be shared safely.
 */
final class FVG_Logger {
    const SOURCE = 'flipick-video-generator';

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
            $line = $message;
            if ($context) {
                $line .= ' ' . wp_json_encode(self::redact($context));
            }
            if (function_exists('wc_get_logger')) {
                wc_get_logger()->log($level, $line, ['source' => self::SOURCE]);
            } else {
                error_log('[' . self::SOURCE . '] ' . $level . ': ' . $line);
            }
        } catch (Throwable $e) {
            // Logging must never break the request.
        }
    }

    private static function redact($value) {
        if (!is_array($value)) {
            return $value;
        }
        $out = [];
        foreach ($value as $k => $v) {
            $out[$k] = (is_string($k) && preg_match('/(secret|token|password|authorization|signature|consumer|credential|key)/i', $k)) ? '[redacted]' : self::redact($v);
        }
        return $out;
    }
}
