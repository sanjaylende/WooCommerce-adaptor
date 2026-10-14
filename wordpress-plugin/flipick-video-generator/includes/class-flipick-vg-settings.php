<?php
defined('ABSPATH') || exit;

/**
 * Plugin settings in one option. The installation secret is encrypted at rest with a key derived from the site's own
 * WordPress salts (libsodium), so a copy of the options table alone does not reveal it.
 */
final class Flipick_VG_Settings {
    const OPTION = 'flipick_vg_settings';

    public static function all() {
        $stored = get_option(self::OPTION, null);
        if ($stored === null) {
            // Sites that ran an early build kept the settings under the old option name: take them over once.
            $old = get_option('fvg_settings', null);
            if (is_array($old)) {
                add_option(self::OPTION, $old, '', false);
                delete_option('fvg_settings');
                wp_clear_scheduled_hook('fvg_rotate_logs');
                $stored = $old;
            }
        }
        $defaults = [
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

    /** How the SERVER reaches the adapter (see Flipick_VG_Endpoints). */
    public static function adapter_url() {
        return Flipick_VG_Endpoints::server_url();
    }

    /** How the BROWSER reaches the adapter, for the frame (see Flipick_VG_Endpoints). */
    public static function adapter_public_url() {
        return Flipick_VG_Endpoints::browser_url();
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
