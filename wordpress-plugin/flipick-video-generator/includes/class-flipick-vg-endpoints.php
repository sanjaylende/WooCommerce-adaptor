<?php
defined('ABSPATH') || exit;

/**
 * The only place that holds the addresses of the Flipick service. There is no settings screen for them.
 *
 * BEFORE A MARKETPLACE RELEASE: set ADAPTER_URL to the production address of the adapter and leave ADAPTER_SERVER_URL empty
 * unless you have a reason (see below). Nothing else in the plugin needs to change. The release checklist and the checks to
 * run afterwards are in PRODUCTION-CONFIGURATION.md in the plugin's root folder.
 *
 * Development override: a developer can still point one site somewhere else (for example at a Cloudflare tunnel whose address
 * changes on every start, or at an adapter on the same machine as a Docker site) by defining FLIPICK_ADAPTER_URL and/or
 * FLIPICK_ADAPTER_SERVER_URL in wp-config.php. The admin screen does not show these and a merchant installing from the
 * WordPress or WooCommerce directory never has them, so the constants below always apply to merchants.
 */
final class Flipick_VG_Endpoints {
    /** Where an admin's BROWSER reaches the adapter (loaded in the frame of the Video Generator page). Must be https in production. */
    const ADAPTER_URL = 'https://woocommerce.flipickvideogenerator.com';

    /**
     * Where this WordPress SERVER reaches the adapter. Leave empty to use ADAPTER_URL (a public address needs nothing else).
     * Only a site running in Docker next to a local adapter needs a different value (http://host.docker.internal:4300).
     */
    const ADAPTER_SERVER_URL = '';

    /** The browser address: the wp-config.php override when there is one, otherwise the constant. */
    public static function browser_url() {
        return untrailingslashit(self::pick(defined('FLIPICK_ADAPTER_URL') ? FLIPICK_ADAPTER_URL : '', self::ADAPTER_URL));
    }

    /** The server address: the wp-config.php override, else the constant, else the browser address. */
    public static function server_url() {
        $server = self::pick(defined('FLIPICK_ADAPTER_SERVER_URL') ? FLIPICK_ADAPTER_SERVER_URL : '', self::ADAPTER_SERVER_URL);
        return $server !== '' ? untrailingslashit($server) : self::browser_url();
    }

    /** The service's public legal pages, shown before a store is connected and in the privacy-policy text. Must be live before the plugin is submitted. */
    const TERMS_URL = 'https://flipickvideogenerator.com/terms/';
    const PRIVACY_URL = 'https://flipickvideogenerator.com/privacy/';

    /** Only http(s) addresses are ever used; anything else counts as "not set". */
    public static function is_valid($url) {
        return $url !== '' && (bool) filter_var($url, FILTER_VALIDATE_URL) && in_array(wp_parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true);
    }

    private static function pick($override, $constant) {
        $value = trim((string) $override);
        return $value !== '' ? $value : (string) $constant;
    }
}
