<?php
defined('ABSPATH') || exit;

/**
 * Connects and disconnects this store.
 *
 * connect():    creates a WooCommerce REST key (read/write) -> registers it with the adapter -> stores the install key and
 *               secret the adapter returns -> creates signed product webhooks. Any failure undoes what was already done.
 * disconnect(): tells the adapter, deletes the webhooks and revokes the REST key. Local cleanup always completes, even
 *               when the adapter cannot be reached.
 */
final class FVG_Connection {
    const WEBHOOK_TOPICS = ['product.created' => 'product created', 'product.updated' => 'product updated', 'product.deleted' => 'product deleted'];

    /** @return true|WP_Error */
    public static function connect($adapter_url, $public_url) {
        try {
            $adapter_url = esc_url_raw(trim((string) $adapter_url));
            if ($adapter_url === '' || !filter_var($adapter_url, FILTER_VALIDATE_URL) || !in_array(wp_parse_url($adapter_url, PHP_URL_SCHEME), ['http', 'https'], true)) {
                return new WP_Error('fvg_bad_url', __('Enter a valid adapter URL, for example https://video.example.com', 'flipick-video-generator'));
            }
            FVG_Settings::update(['adapter_url' => $adapter_url, 'adapter_public_url' => esc_url_raw(trim((string) $public_url))]);
            FVG_Logger::info('Connecting to adapter', ['adapter' => $adapter_url]);

            $key = self::create_rest_key();
            if (is_wp_error($key)) {
                return $key;
            }

            $user = wp_get_current_user();
            $result = FVG_Adapter_Client::register([
                'baseUrl' => untrailingslashit(home_url()),
                'consumerKey' => $key['ck'],
                'consumerSecret' => $key['cs'],
                'merchantName' => get_bloginfo('name'),
                'contactEmail' => $user && $user->user_email ? $user->user_email : get_option('admin_email'),
                'countryCode' => substr((string) wc_get_base_location()['country'], 0, 2),
                'wooVersion' => defined('WC_VERSION') ? WC_VERSION : '',
                'extensionVersion' => FVG_VERSION,
            ]);
            if (is_wp_error($result)) {
                self::delete_rest_key($key['id']);
                return self::explain($result);
            }
            $body = $result['body'];
            if (empty($body['installKey']) || empty($body['secret'])) {
                self::delete_rest_key($key['id']);
                FVG_Logger::error('Adapter registration answered without credentials');
                return new WP_Error('fvg_bad_response', __('The adapter answered without credentials. Check its logs.', 'flipick-video-generator'));
            }
            FVG_Settings::update(['install_key' => (string) $body['installKey'], 'connected_at' => time(), 'api_key_id' => (int) $key['id']]);
            FVG_Settings::set_secret((string) $body['secret']);
            self::create_webhooks((string) $body['installKey'], (string) $body['secret']);
            FVG_Logger::info('Store connected', ['install' => $body['installKey']]);
            return true;
        } catch (Throwable $e) {
            FVG_Logger::error('Connect failed', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
            return new WP_Error('fvg_exception', $e->getMessage());
        }
    }

    /** Turns a transport error into advice the merchant can act on. */
    private static function explain(WP_Error $error) {
        $code = $error->get_error_code();
        $hint = '';
        if ($code === 'fvg_unreachable') {
            $hint = __('Check that the adapter is running and that this server can reach the address. In Docker, use host.docker.internal instead of localhost.', 'flipick-video-generator');
        } elseif ($code === 'fvg_adapter_404' || $code === 'fvg_adapter_405') {
            $hint = __('That address answered, but it is not the Flipick adapter. Check the Adapter URL (no extra path, correct port).', 'flipick-video-generator');
        } elseif (strpos((string) $code, 'fvg_adapter_5') === 0) {
            $hint = __('The adapter reported an internal error. Try again, and check its logs.', 'flipick-video-generator');
        }
        return $hint === '' ? $error : new WP_Error($code, $error->get_error_message() . ' — ' . $hint, $error->get_error_data());
    }

    /** @return true */
    public static function disconnect() {
        try {
            if (FVG_Settings::is_connected()) {
                $result = FVG_Adapter_Client::signed('POST', '/api/v1/uninstall', new stdClass());
                if (is_wp_error($result)) {
                    FVG_Logger::warning('Adapter was not told about the disconnect', ['error' => $result->get_error_message()]);
                }
            }
            foreach ((array) FVG_Settings::get('webhook_ids', []) as $id) {
                $webhook = wc_get_webhook((int) $id);
                if ($webhook) {
                    $webhook->delete(true);
                }
            }
            self::delete_rest_key((int) FVG_Settings::get('api_key_id', 0));
        } catch (Throwable $e) {
            FVG_Logger::error('Disconnect cleanup hit an error', ['error' => $e->getMessage()]);
        }
        FVG_Settings::clear_connection();
        FVG_Logger::info('Store disconnected');
        return true;
    }

    /** Re-reads the store at the adapter (currency changes etc.). @return true|WP_Error */
    public static function resync() {
        $result = FVG_Adapter_Client::signed('POST', '/api/v1/stores/sync', new stdClass());
        return is_wp_error($result) ? $result : true;
    }

    /** @return array{id:int,ck:string,cs:string}|WP_Error */
    private static function create_rest_key() {
        global $wpdb;
        $ck = 'ck_' . wc_rand_hash();
        $cs = 'cs_' . wc_rand_hash();
        $ok = $wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
            'user_id' => get_current_user_id(),
            'description' => 'Flipick Video Generator',
            'permissions' => 'read_write',
            'consumer_key' => wc_api_hash($ck),
            'consumer_secret' => $cs,
            'truncated_key' => substr($ck, -7),
        ]);
        if (!$ok) {
            FVG_Logger::error('Could not create a WooCommerce REST key', ['db_error' => $wpdb->last_error]);
            return new WP_Error('fvg_key', __('Could not create a WooCommerce API key.', 'flipick-video-generator'));
        }
        return ['id' => (int) $wpdb->insert_id, 'ck' => $ck, 'cs' => $cs];
    }

    private static function delete_rest_key($id) {
        global $wpdb;
        if ($id > 0) {
            $wpdb->delete($wpdb->prefix . 'woocommerce_api_keys', ['key_id' => $id]);
        }
    }

    /** Signed with the install secret; the adapter verifies X-WC-Webhook-Signature and de-duplicates by delivery id. */
    private static function create_webhooks($install_key, $secret) {
        $ids = [];
        $url = FVG_Settings::adapter_url() . '/api/webhooks/woocommerce/' . rawurlencode($install_key);
        foreach (self::WEBHOOK_TOPICS as $topic => $label) {
            try {
                $webhook = new WC_Webhook();
                $webhook->set_name('Flipick: ' . $label);
                $webhook->set_user_id(get_current_user_id());
                $webhook->set_topic($topic);
                $webhook->set_secret($secret);
                $webhook->set_delivery_url($url);
                $webhook->set_status('active');
                $ids[] = $webhook->save();
            } catch (Throwable $e) {
                FVG_Logger::warning('Could not create webhook', ['topic' => $topic, 'error' => $e->getMessage()]);
            }
        }
        FVG_Settings::update(['webhook_ids' => $ids]);
    }
}
