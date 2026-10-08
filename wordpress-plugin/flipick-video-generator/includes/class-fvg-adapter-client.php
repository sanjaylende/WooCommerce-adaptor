<?php
defined('ABSPATH') || exit;

/**
 * Server-to-server calls to the Flipick adapter. Signed calls carry
 *   X-Flipick-Key / -Timestamp / -Nonce / -Signature / -Website
 * with signature = hex HMAC-SHA256(secret, "<ts>\n<nonce>\n<METHOD>\n<path+query>\n<sha256 hex of raw body>").
 * Every method returns ['status' => int, 'body' => array] or a WP_Error; nothing here throws.
 */
final class FVG_Adapter_Client {
    const TIMEOUT = 20;

    /** Unsigned: used only for the one-time registration. */
    public static function register(array $payload) {
        return self::send('POST', '/api/v1/register', $payload, false);
    }

    public static function signed($method, $path, $payload = null) {
        return self::send($method, $path, $payload, true);
    }

    /** A short-lived, single-use token that lets the browser open the adapter UI without ever seeing the secret. */
    public static function launch_token() {
        $claims = ['k' => FVG_Settings::get('install_key'), 'w' => '1', 'e' => time() + 300, 'n' => bin2hex(random_bytes(12))];
        $body = rtrim(strtr(base64_encode(wp_json_encode($claims)), '+/', '-_'), '=');
        return $body . '.' . hash_hmac('sha256', $body, FVG_Settings::secret());
    }

    private static function send($method, $path, $payload, $sign) {
        try {
            $base = FVG_Settings::adapter_url();
            if ($base === '') {
                return new WP_Error('fvg_no_adapter', __('The adapter URL is not set.', 'flipick-video-generator'));
            }
            $raw = $payload === null ? '' : wp_json_encode($payload);
            $headers = ['Content-Type' => 'application/json', 'Accept' => 'application/json'];
            if ($sign) {
                $secret = FVG_Settings::secret();
                if ($secret === '') {
                    return new WP_Error('fvg_not_connected', __('This store is not connected to Flipick.', 'flipick-video-generator'));
                }
                $ts = time();
                $nonce = wp_generate_uuid4();
                $headers += [
                    'X-Flipick-Key' => FVG_Settings::get('install_key'),
                    'X-Flipick-Timestamp' => (string) $ts,
                    'X-Flipick-Nonce' => $nonce,
                    'X-Flipick-Website' => '1',
                    'X-Flipick-Signature' => hash_hmac('sha256', $ts . "\n" . $nonce . "\n" . strtoupper($method) . "\n" . $path . "\n" . hash('sha256', $raw), $secret),
                ];
            }
            $started = microtime(true);
            $response = wp_remote_request($base . $path, [
                'method' => strtoupper($method), 'headers' => $headers, 'body' => $raw === '' ? null : $raw,
                'timeout' => self::TIMEOUT, 'redirection' => 0,
            ]);
            $ms = (int) ((microtime(true) - $started) * 1000);
            if (is_wp_error($response)) {
                FVG_Logger::error('Adapter request failed', ['method' => $method, 'path' => $path, 'error' => $response->get_error_message(), 'ms' => $ms]);
                return new WP_Error('fvg_unreachable', sprintf(
                    /* translators: %s: error message */
                    __('Could not reach the Flipick adapter: %s', 'flipick-video-generator'), $response->get_error_message()
                ));
            }
            $status = (int) wp_remote_retrieve_response_code($response);
            $body = json_decode((string) wp_remote_retrieve_body($response), true);
            $body = is_array($body) ? $body : [];
            FVG_Logger::debug('Adapter response', ['method' => $method, 'path' => $path, 'status' => $status, 'ms' => $ms]);
            if ($status >= 400) {
                $message = isset($body['error']) ? (string) $body['error'] : sprintf('HTTP %d', $status);
                FVG_Logger::warning('Adapter rejected request', ['method' => $method, 'path' => $path, 'status' => $status, 'message' => $message]);
                return new WP_Error('fvg_adapter_' . $status, $message, ['status' => $status]);
            }
            return ['status' => $status, 'body' => $body];
        } catch (Throwable $e) {
            FVG_Logger::error('Adapter client crashed', ['method' => $method, 'path' => $path, 'error' => $e->getMessage()]);
            return new WP_Error('fvg_exception', $e->getMessage());
        }
    }
}
