<?php
global $wpdb;
$names = array_map(function ($i) { return wc_get_webhook($i)->get_name(); }, WC_Data_Store::load('webhook')->get_webhooks_ids());
$hooks = count(array_filter($names, function ($n) { return strpos($n, 'Flipick: ') === 0; }));
$keys = (int) $wpdb->get_var("select count(*) from {$wpdb->prefix}woocommerce_api_keys where description='Flipick Video Generator'");
echo "DEBRIS $hooks $keys\n";
