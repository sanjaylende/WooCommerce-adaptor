<?php
defined('ABSPATH') || exit;

/**
 * Plugin settings in one option. The installation secret is encrypted at rest with a key derived from the site's own
 * WordPress salts (libsodium), so a copy of the options table alone does not reveal it.
 */
final class FVG_Settings {
    const OPTION = 'fvg_settings';

    public static function all() {
        $stored = get_option(self::OPTION, []);
        $defaults = [
            // How the SERVER reaches the adapter (from inside Docker, host.docker.internal).
            'adapter_url' => defined('FLIPICK_ADAPTER_URL') ? FLIPICK_ADAPTER_URL : '',
            // How the BROWSER reaches it (for the iframe). Empty = same as adapter_url.
            'adapter_public_url' => '',
            'install_key' => '',
            'secret_enc' => '',
            'connected_at' => 0,
            'api_key_id' => 0,
            'webhook_ids' => [],
        ];
        return array_merge($defaults, is_array($stored) ? $stored : []);
    }

    public static function get($key, $default = '') {
        $all = self::all();
        return isset($all[$key]) ? $all[$key] : $default;
    }

    public static function update(array $values) {
        update_option(self::OPTION, array_merge(self::all(), $values), false);
    }

    public static function clear_connection() {
        self::update(['install_key' => '', 'secret_enc' => '', 'connected_at' => 0, 'api_key_id' => 0, 'webhook_ids' => []]);
    }

    public static function adapter_url() {
        return untrailingslashit((string) self::get('adapter_url'));
    }

    public static function adapter_public_url() {
        $public = (string) self::get('adapter_public_url');
        return untrailingslashit($public !== '' ? $public : (string) self::get('adapter_url'));
    }

    public static function is_connected() {
        return self::get('install_key') !== '' && self::get('secret_enc') !== '';
    }

    public static function set_secret($plain) {
        self::update(['secret_enc' => self::encrypt($plain)]);
    }

    public static function secret() {
        $enc = (string) self::get('secret_enc');
        return $enc === '' ? '' : self::decrypt($enc);
    }

    private static function key() {
        return hash('sha256', wp_salt('auth') . wp_salt('secure_auth'), true);
    }

    private static function encrypt($plain) {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce . sodium_crypto_secretbox((string) $plain, $nonce, self::key()));
    }

    private static function decrypt($blob) {
        $raw = base64_decode($blob, true);
        if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
            return '';
        }
        $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), self::key());
        return $plain === false ? '' : $plain;
    }
}
