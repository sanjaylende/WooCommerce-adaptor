-- WooCommerce webhook deliveries already processed, keyed by X-WC-Webhook-Delivery-ID, so a redelivery is acknowledged but
-- never processed twice. Rows are purged by the scheduler after 7 days.
CREATE TABLE webhook_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(id),
  delivery_id     TEXT NOT NULL,
  topic           TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (installation_id, delivery_id)
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries (received_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO adapter_app;
GRANT USAGE, SELECT ON SEQUENCE webhook_deliveries_id_seq TO adapter_app;
