-- Notifications sent to a phone or browser (Web Push, src/lib/push/): one
-- row for each device that said yes. The first use is a nudge to rate the
-- song Spotify is playing when it is in the library and not yet rated
-- (src/lib/nudge.ts). A push service that answers 404 or 410 has
-- forgotten the device, and its row goes.
CREATE TABLE push_subscription (
    endpoint     TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX push_subscription_user ON push_subscription (user_id);
