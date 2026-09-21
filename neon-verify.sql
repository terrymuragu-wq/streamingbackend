-- ============================================================================
-- AdultBlog · Neon SQL Editor — data verification queries
-- Paste any of these into: Neon Console → your project → SQL Editor → Run
--
-- The backend mirrors the ENTIRE admin-panel database into the table
-- "app_backup": one row per original row, full payload stored as JSONB,
-- refreshed automatically every 2 minutes by the live server.
-- ============================================================================


-- 1) MASTER CHECK — is data being stored, per table, and when last synced?
--    Run this first. Every table of the admin panel should appear here,
--    and last_synced_at should be within the last ~2 minutes when the app runs.
SELECT table_name,
       COUNT(*)        AS rows_backed_up,
       MAX(synced_at)  AS last_synced_at
FROM app_backup
GROUP BY table_name
ORDER BY table_name;


-- 2) FRESHNESS CHECK — how old is the newest backup right now?
--    Should be under 2 minutes while the Render server is live.
SELECT now() - MAX(synced_at) AS backup_age,
       MAX(synced_at)         AS last_sync_at
FROM app_backup;


-- 3) ALL USERS (clients, models, managers, admin)
SELECT (data->>'id')::int                 AS id,
       data->>'email'                     AS email,
       data->>'name'                      AS name,
       data->>'role'                      AS role,
       data->>'status'                    AS status,
       (data->>'verified')::int           AS verified,
       (data->>'eligible')::int           AS eligible,
       (data->>'wallet_cents')::int/100.0 AS wallet_usd,
       data->>'created_at'                AS created_at
FROM app_backup
WHERE table_name = 'users'
ORDER BY (data->>'id')::int;


-- 4) ALL LIVES (scheduled / live / ended)
SELECT (data->>'id')::int              AS id,
       (data->>'model_id')::int        AS model_id,
       data->>'title'                  AS title,
       (data->>'price_cents')::int/100.0 AS ticket_usd,
       data->>'status'                 AS status,
       data->>'scheduled_at'           AS scheduled_at,
       data->>'started_at'             AS started_at,
       data->>'ended_at'               AS ended_at,
       (data->>'peak_viewers')::int    AS peak_viewers
FROM app_backup
WHERE table_name = 'lives'
ORDER BY (data->>'id')::int DESC;


-- 5) ALL WITHDRAWALS (payout requests)
SELECT (data->>'id')::int                 AS id,
       (data->>'model_id')::int           AS model_id,
       (data->>'amount_cents')::int/100.0 AS amount_usd,
       data->>'status'                    AS status,
       data->>'created_at'                AS created_at,
       data->>'updated_at'                AS updated_at
FROM app_backup
WHERE table_name = 'withdrawals'
ORDER BY (data->>'id')::int DESC;


-- 6) ALL MONEY MOVEMENTS (topups, subscriptions, tickets, tips, unlocks, payouts, fees)
SELECT (data->>'id')::int                 AS id,
       (data->>'user_id')::int            AS user_id,
       data->>'kind'                      AS kind,
       (data->>'amount_cents')::int/100.0 AS amount_usd,
       data->>'ref'                       AS ref,
       data->>'created_at'                AS created_at
FROM app_backup
WHERE table_name = 'transactions'
ORDER BY (data->>'id')::int DESC
LIMIT 200;


-- 7) PLATFORM SETTINGS (confirm withdrawal_hold_days = 7)
SELECT row_id      AS setting_key,
       data->>'value' AS setting_value,
       synced_at   AS last_synced_at
FROM app_backup
WHERE table_name = 'settings'
ORDER BY row_id;


-- 8) ALL CONTENT (model uploads + moderation status)
SELECT (data->>'id')::int                 AS id,
       (data->>'model_id')::int           AS model_id,
       data->>'title'                     AS title,
       data->>'kind'                      AS kind,
       (data->>'price_cents')::int/100.0  AS price_usd,
       data->>'status'                    AS status,
       data->>'created_at'                AS created_at
FROM app_backup
WHERE table_name = 'content'
ORDER BY (data->>'id')::int DESC;


-- 9) ALL SUBSCRIPTIONS
SELECT (data->>'id')::int                 AS id,
       (data->>'model_id')::int           AS model_id,
       (data->>'client_id')::int          AS client_id,
       (data->>'price_cents')::int/100.0  AS price_usd,
       data->>'status'                    AS status,
       data->>'created_at'                AS created_at
FROM app_backup
WHERE table_name = 'subscriptions'
ORDER BY (data->>'id')::int DESC;


-- 10) RAW ROW INSPECTOR — see the complete stored payload of any row
--     (change table_name / row_id to inspect anything)
SELECT *
FROM app_backup
WHERE table_name = 'users'
ORDER BY synced_at DESC
LIMIT 10;
