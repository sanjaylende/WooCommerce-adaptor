<?php
defined('ABSPATH') || exit;

/** wp-admin: the Video Generator page (connect / iframe), and a Flipick column + row action on the product list. */
final class FVG_Admin {
    const SLUG = 'flipick-video-generator';
    const CAP = 'manage_woocommerce';
    const STATUS_TRANSIENT = 'fvg_video_states';

    public function register() {
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_post_fvg_connect', [$this, 'handle_connect']);
        add_action('admin_post_fvg_disconnect', [$this, 'handle_disconnect']);
        add_action('admin_post_fvg_resync', [$this, 'handle_resync']);
        add_action('admin_post_fvg_refresh', [$this, 'handle_refresh']);
        add_action('admin_post_fvg_settings', [$this, 'handle_settings']);
        add_action('admin_post_fvg_download_log', [$this, 'handle_download_log']);
        add_filter('manage_edit-product_columns', [$this, 'column']);
        add_action('manage_product_posts_custom_column', [$this, 'column_content'], 10, 2);
        add_filter('post_row_actions', [$this, 'row_action'], 10, 2);
        add_filter('plugin_action_links_' . plugin_basename(FVG_FILE), function ($links) {
            array_unshift($links, '<a href="' . esc_url(self::page_url()) . '">' . esc_html__('Video Generator', 'flipick-video-generator') . '</a>');
            return $links;
        });
    }

    public static function page_url(array $args = []) {
        return add_query_arg(array_merge(['page' => self::SLUG], $args), admin_url('admin.php'));
    }

    public function menu() {
        add_submenu_page('woocommerce', __('Video Generator', 'flipick-video-generator'), __('Video Generator', 'flipick-video-generator'), self::CAP, self::SLUG, [$this, 'render']);
        add_submenu_page('woocommerce', __('Plans & Billing', 'flipick-video-generator'), __('Plans & Billing', 'flipick-video-generator'), self::CAP, self::SLUG . '-billing', [$this, 'render_billing']);
    }

    public function render() {
        try {
            if (!current_user_can(self::CAP)) {
                wp_die(esc_html__('You do not have permission to open this page.', 'flipick-video-generator'));
            }
            echo '<div class="wrap"><h1>' . esc_html__('Flipick Video Generator', 'flipick-video-generator') . '</h1>';
            $this->notices();
            if (FVG_Settings::is_connected()) {
                $this->render_connected();
            } else {
                $this->render_connect_form();
            }
            $this->render_logs();
            echo '</div>';
        } catch (Throwable $e) {
            FVG_Logger::error('Admin page failed to render', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
            echo '<div class="notice notice-error"><p>' . esc_html__('Something went wrong. Details are in WooCommerce > Status > Logs (flipick-video-generator).', 'flipick-video-generator') . '</p></div>';
        }
    }

    /** Plans & Billing: the adapter's billing screens, framed in wp-admin (same as the Magento extension). */
    public function render_billing() {
        try {
            if (!current_user_can(self::CAP)) {
                wp_die(esc_html__('You do not have permission to open this page.', 'flipick-video-generator'));
            }
            echo '<div class="wrap"><h1>' . esc_html__('Plans & Billing', 'flipick-video-generator') . '</h1>';
            $this->notices();
            if (!FVG_Settings::is_connected()) {
                echo '<p>' . sprintf(
                    /* translators: %s: link */
                    esc_html__('Connect this store first: %s', 'flipick-video-generator'),
                    '<a href="' . esc_url(self::page_url()) . '">' . esc_html__('Video Generator', 'flipick-video-generator') . '</a>'
                ) . '</p></div>';
                return;
            }
            $src = FVG_Settings::adapter_public_url() . '/?embed=1&launch=' . rawurlencode(FVG_Adapter_Client::launch_token());
            echo '<iframe title="' . esc_attr__('Plans & Billing', 'flipick-video-generator') . '" src="' . esc_url($src)
                . '" style="width:100%;height:calc(100vh - 220px);min-height:600px;border:1px solid #c3c4c7;background:#fff"></iframe></div>';
        } catch (Throwable $e) {
            FVG_Logger::error('Billing page failed to render', ['error' => $e->getMessage(), 'file' => $e->getFile(), 'line' => $e->getLine()]);
            echo '<div class="notice notice-error"><p>' . esc_html__('Something went wrong. Details are in WooCommerce > Status > Logs (flipick-video-generator).', 'flipick-video-generator') . '</p></div>';
        }
    }

    /** Log files: the live one and the zipped archives, newest first, each downloadable by administrators only. */
    private function render_logs() {
        $dir = FVG_Logger::directory();
        $files = [];
        foreach ((array) glob($dir . '/' . FVG_Logger::SOURCE . '*') as $path) {
            if (is_file($path) && self::is_log_name(basename($path))) {
                $files[] = ['name' => basename($path), 'size' => (int) filesize($path), 'time' => (int) filemtime($path)];
            }
        }
        usort($files, function ($x, $y) { return $y['time'] <=> $x['time']; });
        ?>
        <details style="margin:12px 0">
            <summary><strong><?php esc_html_e('Logs', 'flipick-video-generator'); ?></strong>
                <span class="description">(<?php esc_html_e('rotated daily at 00:05 and whenever a file passes 10 MB; old files are zipped', 'flipick-video-generator'); ?>)</span></summary>
            <?php if (!$files) : ?>
                <p><?php esc_html_e('No log files yet.', 'flipick-video-generator'); ?></p>
            <?php else : ?>
                <table class="widefat striped" style="max-width:720px">
                    <thead><tr><th><?php esc_html_e('File', 'flipick-video-generator'); ?></th><th><?php esc_html_e('Size', 'flipick-video-generator'); ?></th><th><?php esc_html_e('Last written', 'flipick-video-generator'); ?></th></tr></thead>
                    <tbody>
                    <?php foreach (array_slice($files, 0, 60) as $f) : ?>
                        <tr>
                            <td><a href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=fvg_download_log&file=' . rawurlencode($f['name'])), 'fvg_download_log')); ?>"><?php echo esc_html($f['name']); ?></a></td>
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
        $this->guard('fvg_download_log');
        $name = isset($_GET['file']) ? basename((string) wp_unslash($_GET['file'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification -- checked in guard()
        $path = FVG_Logger::directory() . '/' . $name;
        if (!self::is_log_name($name) || !is_file($path)) {
            wp_die(esc_html__('Log file not found.', 'flipick-video-generator'), '', ['response' => 404]);
        }
        nocache_headers();
        header('X-Content-Type-Options: nosniff');
        header('Content-Type: ' . (substr($name, -4) === '.log' ? 'text/plain; charset=utf-8' : 'application/octet-stream'));
        header('Content-Disposition: attachment; filename="' . $name . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    private function render_settings() {
        $s = FVG_Settings::all();
        ?>
        <details style="margin:12px 0">
            <summary><strong><?php esc_html_e('Settings', 'flipick-video-generator'); ?></strong></summary>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="fvg_settings">
                <?php wp_nonce_field('fvg_settings'); ?>
                <table class="form-table" role="presentation">
                    <tr><th scope="row"><label for="fvg_s_adapter"><?php esc_html_e('Adapter URL (server-side)', 'flipick-video-generator'); ?></label></th>
                        <td><input type="url" id="fvg_s_adapter" name="adapter_url" class="regular-text" required value="<?php echo esc_attr($s['adapter_url']); ?>"></td></tr>
                    <tr><th scope="row"><label for="fvg_s_public"><?php esc_html_e('Adapter URL (browser)', 'flipick-video-generator'); ?></label></th>
                        <td><input type="url" id="fvg_s_public" name="public_url" class="regular-text" value="<?php echo esc_attr($s['adapter_public_url']); ?>"></td></tr>
                </table>
                <?php submit_button(__('Save settings', 'flipick-video-generator'), 'secondary'); ?>
            </form>
        </details>
        <?php
    }

    private function notices() {
        // phpcs:ignore WordPress.Security.NonceVerification -- display only
        $msg = isset($_GET['fvg_msg']) ? sanitize_text_field(wp_unslash($_GET['fvg_msg'])) : '';
        $type = isset($_GET['fvg_type']) && $_GET['fvg_type'] === 'error' ? 'error' : 'success'; // phpcs:ignore
        if ($msg !== '') {
            printf('<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr($type), esc_html($msg));
        }
    }

    private function render_connect_form() {
        $s = FVG_Settings::all();
        ?>
        <p><?php esc_html_e('Connect this store to Flipick to generate product videos. This creates a WooCommerce API key for the adapter and registers your store.', 'flipick-video-generator'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="fvg_connect">
            <?php wp_nonce_field('fvg_connect'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="fvg_adapter_url"><?php esc_html_e('Adapter URL', 'flipick-video-generator'); ?></label></th>
                    <td><input type="url" id="fvg_adapter_url" name="adapter_url" class="regular-text" required value="<?php echo esc_attr($s['adapter_url']); ?>" placeholder="https://video.example.com">
                        <p class="description"><?php esc_html_e('Address of the Flipick adapter as reachable from this server.', 'flipick-video-generator'); ?></p></td>
                </tr>
                <tr>
                    <th scope="row"><label for="fvg_public_url"><?php esc_html_e('Browser URL (optional)', 'flipick-video-generator'); ?></label></th>
                    <td><input type="url" id="fvg_public_url" name="public_url" class="regular-text" value="<?php echo esc_attr($s['adapter_public_url']); ?>">
                        <p class="description"><?php esc_html_e('Only when the browser reaches the adapter at a different address (local development).', 'flipick-video-generator'); ?></p></td>
                </tr>
            </table>
            <?php submit_button(__('Connect store', 'flipick-video-generator')); ?>
        </form>
        <?php
    }

    private function render_connected() {
        $focus = isset($_GET['product_id']) ? absint($_GET['product_id']) : 0; // phpcs:ignore WordPress.Security.NonceVerification
        $launch = FVG_Adapter_Client::launch_token();
        $src = FVG_Settings::adapter_public_url() . '/?embed=1&launch=' . rawurlencode($launch) . ($focus ? '&product=' . rawurlencode('woo-' . $focus) : '');
        ?>
        <p>
            <?php
            printf(
                /* translators: %s: date */
                esc_html__('Connected on %s.', 'flipick-video-generator'),
                esc_html(wp_date(get_option('date_format') . ' ' . get_option('time_format'), (int) FVG_Settings::get('connected_at')))
            );
            ?>
            <?php $this->post_button('fvg_refresh', __('Refresh products', 'flipick-video-generator'), 'secondary small'); ?>
            <?php $this->post_button('fvg_resync', __('Re-sync store', 'flipick-video-generator'), 'secondary small'); ?>
            <?php $this->post_button('fvg_disconnect', __('Disconnect', 'flipick-video-generator'), 'link-delete small', __('Disconnect this store from Flipick? Existing videos on product pages stay.', 'flipick-video-generator')); ?>
        </p>
        <?php $this->render_settings(); ?>
        <iframe title="<?php esc_attr_e('Flipick Video Generator', 'flipick-video-generator'); ?>" src="<?php echo esc_url($src); ?>"
                style="width:100%;height:calc(100vh - 220px);min-height:640px;border:1px solid #c3c4c7;background:#fff"></iframe>
        <?php
    }

    private function post_button($action, $label, $class, $confirm = '') {
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="display:inline-block;margin-left:8px"'
            . ($confirm ? ' onsubmit="return confirm(' . esc_attr(wp_json_encode($confirm)) . ')"' : '') . '>';
        echo '<input type="hidden" name="action" value="' . esc_attr($action) . '">';
        wp_nonce_field($action);
        submit_button($label, $class, 'submit', false);
        echo '</form>';
    }

    private function back($message, $type = 'success') {
        wp_safe_redirect(self::page_url(['fvg_msg' => $message, 'fvg_type' => $type]));
        exit;
    }

    private function guard($nonce_action) {
        if (!current_user_can(self::CAP)) {
            wp_die(esc_html__('You do not have permission to do this.', 'flipick-video-generator'), '', ['response' => 403]);
        }
        check_admin_referer($nonce_action);
    }

    public function handle_connect() {
        $this->guard('fvg_connect');
        $result = FVG_Connection::connect(
            isset( $_POST['adapter_url'] ) ? wp_unslash( $_POST['adapter_url'] ) : '', // phpcs:ignore WordPress.Security.NonceVerification.Missing,WordPress.Security.ValidatedSanitizedInput -- nonce checked in guard(); sanitised by esc_url_raw() in FVG_Connection::connect()
            isset( $_POST['public_url'] ) ? wp_unslash( $_POST['public_url'] ) : '' // phpcs:ignore WordPress.Security.NonceVerification.Missing,WordPress.Security.ValidatedSanitizedInput -- nonce checked in guard(); sanitised by esc_url_raw() in FVG_Connection::connect()
        );
        if (is_wp_error($result)) {
            $this->back(sprintf(__('Could not connect: %s', 'flipick-video-generator'), $result->get_error_message()), 'error');
        }
        $this->back(__('Store connected.', 'flipick-video-generator'));
    }

    public function handle_disconnect() {
        $this->guard('fvg_disconnect');
        FVG_Connection::disconnect();
        $this->back(__('Store disconnected.', 'flipick-video-generator'));
    }

    public function handle_resync() {
        $this->guard('fvg_resync');
        $result = FVG_Connection::resync();
        if (is_wp_error($result)) {
            $this->back(sprintf(__('Re-sync failed: %s', 'flipick-video-generator'), $result->get_error_message()), 'error');
        }
        $this->back(__('Store re-synced.', 'flipick-video-generator'));
    }

    public function handle_refresh() {
        $this->guard('fvg_refresh');
        $result = FVG_Adapter_Client::signed('POST', '/api/refresh', new stdClass());
        delete_transient(self::STATUS_TRANSIENT);
        if (is_wp_error($result)) {
            $this->back(sprintf(__('Refresh failed: %s', 'flipick-video-generator'), $result->get_error_message()), 'error');
        }
        $this->back(sprintf(__('Reloaded %d products from WooCommerce.', 'flipick-video-generator'), (int) ($result['body']['count'] ?? 0)));
    }

    public function handle_settings() {
        $this->guard('fvg_settings');
        $adapter = esc_url_raw(trim((string) wp_unslash($_POST['adapter_url'] ?? ''))); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce checked in guard()
        $public = esc_url_raw(trim((string) wp_unslash($_POST['public_url'] ?? ''))); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce checked in guard()
        if ($adapter === '' || !filter_var($adapter, FILTER_VALIDATE_URL) || !in_array(wp_parse_url($adapter, PHP_URL_SCHEME), ['http', 'https'], true) || ($public !== '' && !in_array(wp_parse_url($public, PHP_URL_SCHEME), ['http', 'https'], true))) {
            $this->back(__('Enter a valid adapter URL.', 'flipick-video-generator'), 'error');
        }
        FVG_Settings::update(['adapter_url' => $adapter, 'adapter_public_url' => $public]);
        FVG_Logger::info('Settings saved', ['adapter' => $adapter]);
        $this->back(__('Settings saved. Use Disconnect and Connect again if the adapter moved to a new server.', 'flipick-video-generator'));
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
            $result = FVG_Adapter_Client::signed('GET', '/api/products');
            if (!is_wp_error($result)) {
                foreach ((array) ($result['body']['products'] ?? []) as $row) {
                    if (!empty($row['productId'])) {
                        $states[(string) $row['productId']] = (array) ($row['videos'] ?? []);
                    }
                }
            }
        } catch (Throwable $e) {
            FVG_Logger::warning('Could not read video states', ['error' => $e->getMessage()]);
        }
        set_transient(self::STATUS_TRANSIENT, $states, is_wp_error($result ?? null) || !$states ? 30 : 60);
        return $states;
    }

    private function badge($label, $video) {
        if (empty($video) || empty($video['status'])) {
            return '';
        }
        $status = $video['status'];
        if ($status === 'ready') {
            $text = !empty($video['pushedToStore']) ? __('Published', 'flipick-video-generator') : __('Ready', 'flipick-video-generator');
        } elseif ($status === 'generating') {
            $text = __('Rendering', 'flipick-video-generator') . (isset($video['progressPct']) ? ' ' . (int) $video['progressPct'] . '%' : '');
        } elseif ($status === 'error') {
            $text = __('Failed', 'flipick-video-generator');
        } else {
            return '';
        }
        return '<div>' . esc_html($label) . ': <strong>' . esc_html($text) . '</strong></div>';
    }

    public function column($columns) {
        $columns['fvg_video'] = __('Video', 'flipick-video-generator');
        return $columns;
    }

    public function column_content($column, $post_id) {
        if ($column !== 'fvg_video') {
            return;
        }
        $states = FVG_Settings::is_connected() ? $this->video_states() : [];
        $videos = $states[(string) $post_id] ?? [];
        $html = $this->badge(__('Hero', 'flipick-video-generator'), $videos['hero_product'] ?? null)
            . $this->badge(__('Lifestyle', 'flipick-video-generator'), $videos['lifestyle'] ?? null)
            . $this->badge(__('Transitions', 'flipick-video-generator'), $videos['image_transition'] ?? null);
        if ((string) get_post_meta($post_id, FVG_META_VIDEO_URL, true) !== '') {
            $html .= '<div title="' . esc_attr__('A Flipick video is shown on the product page', 'flipick-video-generator') . '">&#9654; ' . esc_html__('On product page', 'flipick-video-generator') . '</div>';
        }
        echo $html !== '' ? $html : '&mdash;'; // phpcs:ignore WordPress.Security.EscapeOutput -- every part is escaped above
    }

    public function row_action($actions, $post) {
        if ($post->post_type === 'product' && FVG_Settings::is_connected() && current_user_can(self::CAP)) {
            $actions['fvg_video'] = '<a href="' . esc_url(self::page_url(['product_id' => (int) $post->ID])) . '">' . esc_html__('Generate video', 'flipick-video-generator') . '</a>';
        }
        return $actions;
    }
}
