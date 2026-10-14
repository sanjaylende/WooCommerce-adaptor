<?php
defined('ABSPATH') || exit;

/** wp-admin: the Video Generator page (connect / iframe), and a Flipick column + row action on the product list. */
final class Flipick_VG_Admin {
    const SLUG = 'flipick-video-generator';
    const CAP = 'manage_woocommerce';
    const STATUS_TRANSIENT = 'flipick_vg_video_states';

    public function register() {
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_enqueue_scripts', [$this, 'assets']);
        add_action('admin_init', [$this, 'privacy_policy_content']);
        add_action('admin_post_flipick_vg_connect', [$this, 'handle_connect']);
        add_action('admin_post_flipick_vg_disconnect', [$this, 'handle_disconnect']);
        add_action('admin_post_flipick_vg_resync', [$this, 'handle_resync']);
        add_action('admin_post_flipick_vg_refresh', [$this, 'handle_refresh']);
        add_action('admin_post_flipick_vg_download_log', [$this, 'handle_download_log']);
        add_filter('manage_edit-product_columns', [$this, 'column']);
        add_action('manage_product_posts_custom_column', [$this, 'column_content'], 10, 2);
        add_filter('post_row_actions', [$this, 'row_action'], 10, 2);
        add_filter('plugin_action_links_' . plugin_basename(FLIPICK_VG_FILE), function ($links) {
            array_unshift($links, '<a href="' . esc_url(self::page_url()) . '">' . esc_html__('Flipick Video Generator', 'flipick-video-generator-for-woocommerce') . '</a>');
            return $links;
        });
    }

    public static function page_url(array $args = []) {
        return add_query_arg(array_merge(['page' => self::SLUG], $args), admin_url('admin.php'));
    }

    public function menu() {
        add_submenu_page('woocommerce', __('Flipick Video Generator', 'flipick-video-generator-for-woocommerce'), __('Flipick Video Generator', 'flipick-video-generator-for-woocommerce'), self::CAP, self::SLUG, [$this, 'render']);
    }

    /** Style and script of the plugin's own page, loaded on that page only. */
    public function assets($hook) {
        if ($hook !== 'woocommerce_page_' . self::SLUG) {
            return;
        }
        wp_enqueue_style('flipick-vg-admin', plugins_url('assets/admin.css', FLIPICK_VG_FILE), [], FLIPICK_VG_VERSION);
        wp_enqueue_script('flipick-vg-admin', plugins_url('assets/admin.js', FLIPICK_VG_FILE), [], FLIPICK_VG_VERSION, true);
    }

    /** Text for Settings > Privacy > Policy Guide: what leaves the site when the store is connected. */
    public function privacy_policy_content() {
        if (!function_exists('wp_add_privacy_policy_content')) {
            return;
        }
        $text = '<h2>' . esc_html__('Flipick Video Generator', 'flipick-video-generator-for-woocommerce') . '</h2><p>'
            . esc_html__('When an administrator connects the store to the Flipick video service, this plugin sends the site address, site name, the administrator\'s e-mail address, the store country, the WooCommerce version and a WooCommerce API key to the Flipick service (an external service run by Flipick). The service then reads the store\'s product data (names, descriptions, prices, categories and images) through the WooCommerce REST API and receives product-change notifications (webhooks). It generates the videos on its servers and stores them; the video address is saved in the product and shown to visitors, whose browsers load the video file from Flipick\'s storage. No personal data of the store\'s customers or orders is sent. Disconnecting the store, or deleting the plugin, removes the API key and tells the service.', 'flipick-video-generator-for-woocommerce')
            . '</p><p>' . sprintf(
                /* translators: 1: terms of service address, 2: privacy policy address */
                esc_html__('Terms: %1$s. Privacy policy: %2$s.', 'flipick-video-generator-for-woocommerce'),
                esc_url(Flipick_VG_Endpoints::TERMS_URL),
                esc_url(Flipick_VG_Endpoints::PRIVACY_URL)
            ) . '</p>';
        wp_add_privacy_policy_content(__('Flipick Video Generator', 'flipick-video-generator-for-woocommerce'), wp_kses_post($text));
    }

    public function render() {
        try {
            if (!current_user_can(self::CAP)) {
                wp_die(esc_html__('You do not have permission to open this page.', 'flipick-video-generator-for-woocommerce'));
            }
            echo '<div class="wrap"><h1>' . esc_html__('Flipick Video Generator', 'flipick-video-generator-for-woocommerce') . '</h1>';
            $this->notices();
            if (Flipick_VG_Settings::is_connected()) {
                $this->render_connected();
            } else {
                $this->render_connect_form();
            }
            $this->render_logs();
            echo '</div>';
        } catch (Throwable $e) {
            Flipick_VG_Logger::error('Admin page failed to render', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
            echo '<div class="notice notice-error"><p>' . esc_html__('Something went wrong. Details are in WooCommerce > Status > Logs (flipick-video-generator).', 'flipick-video-generator-for-woocommerce') . '</p></div>';
        }
    }

    /** Log files: the live one and the zipped archives, newest first, each downloadable by administrators only. */
    private function render_logs() {
        $dir = Flipick_VG_Logger::directory();
        $files = [];
        foreach ((array) glob($dir . '/' . Flipick_VG_Logger::SOURCE . '*') as $path) {
            if (is_file($path) && self::is_log_name(basename($path))) {
                $files[] = ['name' => basename($path), 'size' => (int) filesize($path), 'time' => (int) filemtime($path)];
            }
        }
        usort($files, function ($x, $y) { return $y['time'] <=> $x['time']; });
        ?>
        <details class="flipick-vg-logs">
            <summary><strong><?php esc_html_e('Logs', 'flipick-video-generator-for-woocommerce'); ?></strong>
                <span class="description">(<?php esc_html_e('rotated daily at 00:05 and whenever a file passes 10 MB; old files are zipped', 'flipick-video-generator-for-woocommerce'); ?>)</span></summary>
            <?php if (!$files) : ?>
                <p><?php esc_html_e('No log files yet.', 'flipick-video-generator-for-woocommerce'); ?></p>
            <?php else : ?>
                <table class="widefat striped">
                    <thead><tr><th><?php esc_html_e('File', 'flipick-video-generator-for-woocommerce'); ?></th><th><?php esc_html_e('Size', 'flipick-video-generator-for-woocommerce'); ?></th><th><?php esc_html_e('Last written', 'flipick-video-generator-for-woocommerce'); ?></th></tr></thead>
                    <tbody>
                    <?php foreach (array_slice($files, 0, 60) as $f) : ?>
                        <tr>
                            <td><a href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=flipick_vg_download_log&file=' . rawurlencode($f['name'])), 'flipick_vg_download_log')); ?>"><?php echo esc_html($f['name']); ?></a></td>
                            <td><?php echo esc_html(size_format($f['size'])); ?></td>
                            <td><?php echo esc_html(wp_date(get_option('date_format') . ' ' . get_option('time_format'), $f['time'])); ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>
        </details>
        <?php
    }

    private static function is_log_name($name) {
        return (bool) preg_match('/^flipick-video-generator(-\d{4}-\d{2}-\d{2}(-\d{6})?(-\d+)?)?\.(log|zip|log\.gz)$/', $name);
    }

    public function handle_download_log() {
        $this->guard('flipick_vg_download_log');
        $name = isset($_GET['file']) ? sanitize_file_name(wp_unslash($_GET['file'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the nonce is checked in guard() above
        $path = Flipick_VG_Logger::directory() . '/' . $name;
        if (!self::is_log_name($name) || !is_file($path)) {
            wp_die(esc_html__('Log file not found.', 'flipick-video-generator-for-woocommerce'), '', ['response' => 404]);
        }
        nocache_headers();
        header('X-Content-Type-Options: nosniff');
        header('Content-Type: ' . (substr($name, -4) === '.log' ? 'text/plain; charset=utf-8' : 'application/octet-stream'));
        header('Content-Disposition: attachment; filename="' . $name . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile -- streams a log file (up to 10 MB, or a zip) of the plugin's own folder; the name is checked against a fixed pattern above
        exit;
    }

    private function notices() {
        $key = 'flipick_vg_notice_' . get_current_user_id();
        $notice = get_transient($key);
        if (is_array($notice) && !empty($notice['message'])) {
            delete_transient($key);
            printf('<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr($notice['type'] === 'error' ? 'error' : 'success'), esc_html($notice['message']));
        }
    }

    private function render_connect_form() {
        ?>
        <div class="flipick-vg-disclosure">
            <p><?php esc_html_e('Connect this store to the Flipick video service to generate product videos. Flipick is an external service: this plugin does nothing until you press the button below.', 'flipick-video-generator-for-woocommerce'); ?></p>
            <p><strong><?php esc_html_e('When you press Connect, the following is sent to Flipick:', 'flipick-video-generator-for-woocommerce'); ?></strong></p>
            <ul class="ul-disc">
                <li><?php esc_html_e('your site address and name, your e-mail address, the store country and the WooCommerce version;', 'flipick-video-generator-for-woocommerce'); ?></li>
                <li><?php esc_html_e('a new WooCommerce API key (read/write) that lets Flipick read your products and save the video address in them; it is created now and deleted when you disconnect or delete the plugin.', 'flipick-video-generator-for-woocommerce'); ?></li>
            </ul>
            <p><?php esc_html_e('Afterwards Flipick reads your product data (names, descriptions, prices, categories, images) and receives product-change notifications. No customer or order data is sent. The free plan includes a limited number of videos; further videos need a paid plan with Flipick.', 'flipick-video-generator-for-woocommerce'); ?></p>
            <p>
                <?php
                printf(
                    /* translators: 1: link to the terms of service, 2: link to the privacy policy */
                    esc_html__('By connecting you agree to the %1$s and the %2$s.', 'flipick-video-generator-for-woocommerce'),
                    '<a href="' . esc_url(Flipick_VG_Endpoints::TERMS_URL) . '" target="_blank" rel="noopener noreferrer">' . esc_html__('Terms of Service', 'flipick-video-generator-for-woocommerce') . '</a>',
                    '<a href="' . esc_url(Flipick_VG_Endpoints::PRIVACY_URL) . '" target="_blank" rel="noopener noreferrer">' . esc_html__('Privacy Policy', 'flipick-video-generator-for-woocommerce') . '</a>'
                );
                ?>
            </p>
        </div>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="flipick_vg_connect">
            <?php wp_nonce_field('flipick_vg_connect'); ?>
            <?php submit_button(__('Connect to Flipick', 'flipick-video-generator-for-woocommerce')); ?>
        </form>
        <?php
    }

    private function render_connected() {
        $focus = isset($_GET['product_id']) ? absint($_GET['product_id']) : 0; // phpcs:ignore WordPress.Security.NonceVerification
        $launch = Flipick_VG_Adapter_Client::launch_token();
        $src = Flipick_VG_Settings::adapter_public_url() . '/?embed=1&launch=' . rawurlencode($launch) . ($focus ? '&product=' . rawurlencode('woo-' . $focus) : '');
        ?>
        <p>
            <?php
            printf(
                /* translators: %s: date */
                esc_html__('Connected on %s.', 'flipick-video-generator-for-woocommerce'),
                esc_html(wp_date(get_option('date_format') . ' ' . get_option('time_format'), (int) Flipick_VG_Settings::get('connected_at')))
            );
            ?>
            <?php $this->post_button('flipick_vg_refresh', __('Refresh products', 'flipick-video-generator-for-woocommerce'), 'secondary small'); ?>
            <?php $this->post_button('flipick_vg_resync', __('Re-sync store', 'flipick-video-generator-for-woocommerce'), 'secondary small'); ?>
            <?php $this->post_button('flipick_vg_disconnect', __('Disconnect', 'flipick-video-generator-for-woocommerce'), 'link-delete small', __('Disconnect this store from Flipick? Existing videos on product pages stay.', 'flipick-video-generator-for-woocommerce')); ?>
        </p>
        <iframe class="flipick-vg-frame" title="<?php esc_attr_e('Flipick Video Generator', 'flipick-video-generator-for-woocommerce'); ?>" src="<?php echo esc_url($src); ?>" referrerpolicy="strict-origin"></iframe>
        <?php
    }

    private function post_button($action, $label, $class, $confirm = '') {
        echo '<form method="post" class="flipick-vg-inline-form" action="' . esc_url(admin_url('admin-post.php')) . '"'
            . ($confirm ? ' data-confirm="' . esc_attr($confirm) . '"' : '') . '>';
        echo '<input type="hidden" name="action" value="' . esc_attr($action) . '">';
        wp_nonce_field($action);
        submit_button($label, $class, 'submit', false);
        echo '</form>';
    }

    private function back($message, $type = 'success') {
        set_transient('flipick_vg_notice_' . get_current_user_id(), ['message' => (string) $message, 'type' => $type], 60);
        wp_safe_redirect(self::page_url());
        exit;
    }

    private function guard($nonce_action) {
        if (!current_user_can(self::CAP)) {
            wp_die(esc_html__('You do not have permission to do this.', 'flipick-video-generator-for-woocommerce'), '', ['response' => 403]);
        }
        check_admin_referer($nonce_action);
    }

    public function handle_connect() {
        $this->guard('flipick_vg_connect');
        $result = Flipick_VG_Connection::connect();
        if (is_wp_error($result)) {
            /* translators: %s: error message */
            $this->back(sprintf(__('Could not connect: %s', 'flipick-video-generator-for-woocommerce'), $result->get_error_message()), 'error');
        }
        $this->back(__('Store connected.', 'flipick-video-generator-for-woocommerce'));
    }

    public function handle_disconnect() {
        $this->guard('flipick_vg_disconnect');
        Flipick_VG_Connection::disconnect();
        $this->back(__('Store disconnected.', 'flipick-video-generator-for-woocommerce'));
    }

    public function handle_resync() {
        $this->guard('flipick_vg_resync');
        $result = Flipick_VG_Connection::resync();
        if (is_wp_error($result)) {
            /* translators: %s: error message */
            $this->back(sprintf(__('Re-sync failed: %s', 'flipick-video-generator-for-woocommerce'), $result->get_error_message()), 'error');
        }
        $this->back(__('Store re-synced.', 'flipick-video-generator-for-woocommerce'));
    }

    public function handle_refresh() {
        $this->guard('flipick_vg_refresh');
        $result = Flipick_VG_Adapter_Client::signed('POST', '/api/refresh', new stdClass());
        delete_transient(self::STATUS_TRANSIENT);
        if (is_wp_error($result)) {
            /* translators: %s: error message */
            $this->back(sprintf(__('Refresh failed: %s', 'flipick-video-generator-for-woocommerce'), $result->get_error_message()), 'error');
        }
        /* translators: %d: number of products */
        $this->back(sprintf(__('Reloaded %d products from WooCommerce.', 'flipick-video-generator-for-woocommerce'), (int) ($result['body']['count'] ?? 0)));
    }

    /**
     * Per-type video state of every product, from ONE adapter call cached for a minute, so the product list stays fast however
     * many rows it shows. A failure is cached too (empty), so an unreachable adapter cannot slow every page load.
     */
    private function video_states() {
        $cached = get_transient(self::STATUS_TRANSIENT);
        if (is_array($cached)) {
            return $cached;
        }
        $states = [];
        try {
            $result = Flipick_VG_Adapter_Client::signed('GET', '/api/products', null, Flipick_VG_Adapter_Client::PAGE_TIMEOUT);
            if (!is_wp_error($result)) {
                foreach ((array) ($result['body']['products'] ?? []) as $row) {
                    if (!empty($row['productId'])) {
                        $states[(string) $row['productId']] = (array) ($row['videos'] ?? []);
                    }
                }
            }
        } catch (Throwable $e) {
            Flipick_VG_Logger::warning('Could not read video states', ['error' => $e->getMessage()]);
        }
        // A failure is remembered for a minute (an adapter that is down or hanging is asked once a minute, not on every page); an empty answer for 30 s.
        set_transient(self::STATUS_TRANSIENT, $states, is_wp_error($result ?? null) ? 60 : (!$states ? 30 : 60));
        return $states;
    }

    private function badge($label, $video) {
        if (empty($video) || empty($video['status'])) {
            return '';
        }
        $status = $video['status'];
        if ($status === 'ready') {
            $text = !empty($video['pushedToStore']) ? __('Published', 'flipick-video-generator-for-woocommerce') : __('Ready', 'flipick-video-generator-for-woocommerce');
        } elseif ($status === 'generating') {
            $text = __('Rendering', 'flipick-video-generator-for-woocommerce') . (isset($video['progressPct']) ? ' ' . (int) $video['progressPct'] . '%' : '');
        } elseif ($status === 'error') {
            $text = __('Failed', 'flipick-video-generator-for-woocommerce');
        } else {
            return '';
        }
        return '<div>' . esc_html($label) . ': <strong>' . esc_html($text) . '</strong></div>';
    }

    public function column($columns) {
        $columns['flipick_vg_video'] = __('Video', 'flipick-video-generator-for-woocommerce');
        return $columns;
    }

    public function column_content($column, $post_id) {
        if ($column !== 'flipick_vg_video') {
            return;
        }
        $states = Flipick_VG_Settings::is_connected() ? $this->video_states() : [];
        $videos = $states[(string) $post_id] ?? [];
        $html = $this->badge(__('Hero', 'flipick-video-generator-for-woocommerce'), $videos['hero_product'] ?? null)
            . $this->badge(__('Lifestyle', 'flipick-video-generator-for-woocommerce'), $videos['lifestyle'] ?? null)
            . $this->badge(__('Transitions', 'flipick-video-generator-for-woocommerce'), $videos['image_transition'] ?? null);
        if ((string) get_post_meta($post_id, FLIPICK_VG_META_VIDEO_URL, true) !== '') {
            $html .= '<div title="' . esc_attr__('A Flipick video is shown on the product page', 'flipick-video-generator-for-woocommerce') . '">&#9654; ' . esc_html__('On product page', 'flipick-video-generator-for-woocommerce') . '</div>';
        }
        echo $html !== '' ? $html : '&mdash;'; // phpcs:ignore WordPress.Security.EscapeOutput -- every part is escaped above
    }

    public function row_action($actions, $post) {
        if ($post->post_type === 'product' && Flipick_VG_Settings::is_connected() && current_user_can(self::CAP)) {
            $actions['flipick_vg_video'] = '<a href="' . esc_url(self::page_url(['product_id' => (int) $post->ID])) . '">' . esc_html__('Generate video', 'flipick-video-generator-for-woocommerce') . '</a>';
        }
        return $actions;
    }
}
