<?php
/**
 * Idempotent demo data for the local store: categories, tags, simple + variable products (with generated images),
 * stock levels, customers and orders in several statuses. Run with:  wp eval-file /seed/seed.php
 * Re-running adds nothing that already exists (matched by SKU / e-mail / order note marker).
 */
if (!defined('ABSPATH')) { exit; }

// No outgoing mail from seeding (the dev container has no mail server).
add_filter('pre_wp_mail', '__return_true');

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

function seed_term($name, $taxonomy) {
    $t = term_exists($name, $taxonomy);
    if (!$t) { $t = wp_insert_term($name, $taxonomy); }
    return is_wp_error($t) ? 0 : (int) (is_array($t) ? $t['term_id'] : $t);
}

// A flat coloured PNG with the product name on it: no network needed, and it gives the video engine a real image.
function seed_image($label, $rgb) {
    $w = 1000; $h = 1000;
    $im = imagecreatetruecolor($w, $h);
    $bg = imagecolorallocate($im, $rgb[0], $rgb[1], $rgb[2]);
    imagefilledrectangle($im, 0, 0, $w, $h, $bg);
    $white = imagecolorallocate($im, 255, 255, 255);
    imagefilledellipse($im, 500, 460, 520, 520, imagecolorallocatealpha($im, 255, 255, 255, 90));
    imagestring($im, 5, 40, 940, $label, $white);
    $dir = wp_upload_dir();
    $file = trailingslashit($dir['path']) . 'seed-' . sanitize_title($label) . '.png';
    imagepng($im, $file);
    imagedestroy($im);
    $att = wp_insert_attachment(['post_mime_type' => 'image/png', 'post_title' => $label, 'post_status' => 'inherit'], $file);
    wp_update_attachment_metadata($att, wp_generate_attachment_metadata($att, $file));
    return $att;
}

$products = [
    ['sku' => 'FRU-APL-001', 'name' => 'Kashmiri Apples 1kg', 'cat' => 'Fruits', 'tags' => ['fresh', 'organic'], 'price' => '8.50', 'sale' => '', 'stock' => 120, 'rgb' => [200, 40, 40]],
    ['sku' => 'FRU-BAN-001', 'name' => 'Robusta Bananas 1 dozen', 'cat' => 'Fruits', 'tags' => ['fresh'], 'price' => '3.20', 'sale' => '2.80', 'stock' => 60, 'rgb' => [230, 190, 40]],
    ['sku' => 'DAI-MLK-001', 'name' => 'Whole Milk 1L', 'cat' => 'Dairy & Eggs', 'tags' => ['dairy'], 'price' => '1.90', 'sale' => '', 'stock' => 0, 'rgb' => [90, 130, 200], 'backorders' => 'notify'],
    ['sku' => 'BAK-BRD-001', 'name' => 'Sourdough Loaf', 'cat' => 'Bakery', 'tags' => ['fresh', 'bakery'], 'price' => '5.00', 'sale' => '', 'stock' => 15, 'rgb' => [170, 120, 70]],
    ['sku' => 'BEV-TEA-001', 'name' => 'Assam Black Tea 250g', 'cat' => 'Beverages', 'tags' => ['tea'], 'price' => '6.40', 'sale' => '5.40', 'stock' => 300, 'rgb' => [110, 70, 40], 'manage' => false],
];
foreach ($products as $p) {
    if (wc_get_product_id_by_sku($p['sku'])) { continue; }
    $prod = new WC_Product_Simple();
    $prod->set_name($p['name']);
    $prod->set_sku($p['sku']);
    $prod->set_regular_price($p['price']);
    if ($p['sale'] !== '') { $prod->set_sale_price($p['sale']); }
    $prod->set_status('publish');
    $prod->set_catalog_visibility('visible');
    $prod->set_description('Demo product ' . $p['name'] . '.');
    if (($p['manage'] ?? true)) {
        $prod->set_manage_stock(true);
        $prod->set_stock_quantity($p['stock']);
        $prod->set_backorders($p['backorders'] ?? 'no');
    } else {
        $prod->set_stock_status('instock');
    }
    $prod->set_category_ids([seed_term($p['cat'], 'product_cat')]);
    $prod->set_tag_ids(array_map(function ($t) { return seed_term($t, 'product_tag'); }, $p['tags']));
    $prod->set_image_id(seed_image($p['name'], $p['rgb']));
    $prod->save();
    echo "Created product {$p['sku']}\n";
}

// Variable products: one attribute (Size) with three variations each, different prices and stock.
$variables = [
    ['sku' => 'APP-TEE-001', 'name' => 'Classic Cotton T-Shirt', 'cat' => 'T-Shirts', 'rgb' => [40, 90, 160], 'base' => 19, 'sizes' => ['S' => 5, 'M' => 12, 'L' => 0]],
    ['sku' => 'APP-HOD-001', 'name' => 'Everyday Hoodie', 'cat' => 'Hoodies & Sweatshirts', 'rgb' => [60, 60, 70], 'base' => 42, 'sizes' => ['M' => 8, 'L' => 8, 'XL' => 3]],
];
foreach ($variables as $v) {
    if (wc_get_product_id_by_sku($v['sku'])) { continue; }
    $attr = new WC_Product_Attribute();
    $attr->set_name('Size');
    $attr->set_options(array_keys($v['sizes']));
    $attr->set_visible(true);
    $attr->set_variation(true);
    $prod = new WC_Product_Variable();
    $prod->set_name($v['name']);
    $prod->set_sku($v['sku']);
    $prod->set_status('publish');
    $prod->set_attributes([$attr]);
    $prod->set_category_ids([seed_term($v['cat'], 'product_cat')]);
    $prod->set_tag_ids([seed_term('apparel', 'product_tag')]);
    $prod->set_image_id(seed_image($v['name'], $v['rgb']));
    $parent = $prod->save();
    $i = 0;
    foreach ($v['sizes'] as $size => $stock) {
        $var = new WC_Product_Variation();
        $var->set_parent_id($parent);
        $var->set_sku($v['sku'] . '-' . $size);
        $var->set_attributes(['size' => $size]);
        $var->set_regular_price((string) ($v['base'] + $i * 2));
        if ($i === 1) { $var->set_sale_price((string) ($v['base'] + $i * 2 - 3)); }
        $var->set_manage_stock(true);
        $var->set_stock_quantity($stock);
        $var->set_stock_status($stock > 0 ? 'instock' : 'outofstock');
        $var->save();
        $i++;
    }
    WC_Product_Variable::sync($parent);
    echo "Created variable product {$v['sku']}\n";
}

// Customers.
$customers = [
    ['asha@example.test', 'Asha', 'Rao', 'Pune', 'IN', 'MH'],
    ['liam@example.test', 'Liam', 'Cole', 'Austin', 'US', 'TX'],
    ['mia@example.test', 'Mia', 'Novak', 'Berlin', 'DE', ''],
];
$customer_ids = [];
foreach ($customers as $c) {
    $id = email_exists($c[0]);
    if (!$id) {
        $cust = new WC_Customer();
        $cust->set_email($c[0]);
        $cust->set_username(strstr($c[0], '@', true));
        $cust->set_password(wp_generate_password());
        $cust->set_first_name($c[1]);
        $cust->set_last_name($c[2]);
        $cust->set_billing_first_name($c[1]);
        $cust->set_billing_last_name($c[2]);
        $cust->set_billing_email($c[0]);
        $cust->set_billing_city($c[3]);
        $cust->set_billing_country($c[4]);
        $cust->set_billing_state($c[5]);
        $id = $cust->save();
        echo "Created customer {$c[0]}\n";
    }
    $customer_ids[] = (int) $id;
}

// Orders in different statuses (skipped when the marker order already exists).
$existing = wc_get_orders(['limit' => 1, 'meta_key' => '_flipick_seed', 'meta_value' => '1', 'return' => 'ids']);
if (!$existing) {
    $statuses = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
    $skus = ['FRU-APL-001', 'FRU-BAN-001', 'BAK-BRD-001', 'BEV-TEA-001'];
    foreach ($statuses as $n => $status) {
        $order = wc_create_order(['customer_id' => $customer_ids[$n % count($customer_ids)]]);
        $pid = wc_get_product_id_by_sku($skus[$n % count($skus)]);
        $order->add_product(wc_get_product($pid), 1 + ($n % 3));
        $order->set_billing_email($customers[$n % count($customers)][0]);
        $order->set_payment_method('cod');
        $order->set_payment_method_title('Cash on delivery');
        $order->calculate_totals();
        $order->update_meta_data('_flipick_seed', '1');
        $order->set_status($status);
        $order->save();
        echo "Created order #{$order->get_id()} ($status)\n";
    }
}
echo "Seed complete.\n";
