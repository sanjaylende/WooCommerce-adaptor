=== Flipick Video Generator for WooCommerce ===
Contributors: flipick
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Generate product videos with Flipick and show them on your WooCommerce product pages.

== Description ==

Connect your store to the Flipick video adapter, choose a product, generate a video, and publish it to the product page.

* Connect / Disconnect / Re-sync from WooCommerce > Video Generator.
* Creates one WooCommerce REST API key (Read/Write) for the adapter; Disconnect removes it.
* Registers signed webhooks (product created / updated / deleted) so the adapter's catalog stays fresh.
* Shows the published video after the product summary, or anywhere with [flipick_video id="123"].
* Adds a "Video" column and a "Generate video" row action to the product list.
* Declares compatibility with High-Performance Order Storage (it never touches orders).

== Installation ==

1. Copy the `flipick-video-generator` folder to `wp-content/plugins/` and activate it (WooCommerce must be active).
2. WooCommerce > Video Generator: enter the adapter URL and press Connect store.

== Data sent to the adapter ==

Site URL, site name, admin e-mail, store country, WooCommerce version, and a Read/Write REST key pair (stored encrypted by the adapter).
Product data is read by the adapter through the WooCommerce REST API; nothing is sent from the browser.

== Logs ==

wp-content/uploads/flipick-video-generator-logs/ (closed to the web; listed and downloadable under WooCommerce > Video Generator > Logs). Rotated every day at 00:05 (site timezone) and whenever a file passes 10 MB: the old file is zipped and a new one started. Secrets are never logged.

== Changelog ==

= 1.0.0 =
* First release.
