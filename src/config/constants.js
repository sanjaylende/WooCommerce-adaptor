// The two product meta keys the WordPress plugin (Flipick Video Generator) reads on the storefront to render a <video>.
const VIDEO_URL_META_KEY = "_flipick_video_url";
const VIDEO_THUMBNAIL_META_KEY = "_flipick_video_thumb";

const VIDEO_TYPES = { hero_product: "Hero Product", lifestyle: "Lifestyle", image_transition: "Image Transitions" };

// Statuses a version can be in. "candidates"/"expired" are preview-only states (the 4 starting stills), not real renders.
const STATUS = {
  CANDIDATES: "candidates", EXPIRED: "expired", GENERATING: "generating", READY: "ready", ERROR: "error", CANCELED: "canceled",
};
const PREVIEW_STATUSES = [STATUS.CANDIDATES, STATUS.EXPIRED];

module.exports = { VIDEO_URL_META_KEY, VIDEO_THUMBNAIL_META_KEY, VIDEO_TYPES, STATUS, PREVIEW_STATUSES };
