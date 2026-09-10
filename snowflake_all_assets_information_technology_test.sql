/*************************************************************sti******************
 * Snowflake All-Asset Test Export — Information Technology L1 Domain
 *
 * Purpose:
 *   Produce one row per in-scope Snowflake table assigned to the L1 domain
 *   Information Technology. This query intentionally does not filter on activity
 *   or staleness; the application evaluates lifecycle state from the complete feed.
 *
 * Ownership output:
 *   - SNOWFLAKE_TABLE_OWNER: native Snowflake table owner
 *   - SF_DPM_TEAM: accountable Data Product Management Team
 *   - SF_BDS_TEAM: accountable Business Data Steward Team
 *   - SF_BUSINESS_STEWARD: named/tagged business steward
 *   - SF_TECHNICAL_STEWARD: named/tagged technical steward
 *   - OWNERSHIP_STATUS: KNOWN | ORPHANED
 *   - SNOWFLAKE_DATA_STATUS: ACTIVE | RESTRICTED lifecycle evidence
 *
 * Ownership rule:
 *   KNOWN means a DPMT or BDST assignment is present. ORPHANED means neither is
 *   present. Steward and Snowflake-owner values remain contact-coverage signals.
 *******************************************************************************/

WITH tbls AS (
    -- Complete table universe: every table in scope, active or inactive.
    SELECT
        table_catalog AS database_name,
        table_schema  AS schema_name,
        table_name,
        table_type,
        table_owner,
        row_count,
        bytes,
        last_altered
    FROM snowflake_ops.account_usage.tables
    WHERE deleted IS NULL
),

scoped_tags AS (
    -- Normalize ownership and domain tag names at table grain.
    SELECT
        tr.object_database,
        tr.object_schema,
        tr.object_name,
        CASE UPPER(tr.tag_name)
            WHEN 'BIZ_DATASTEWARD_TEAM' THEN 'BDS_TEAM'
            WHEN 'BDS_TEAM'             THEN 'BDS_TEAM'
            WHEN 'BUSINESS_STEWARD'     THEN 'BUSINESS_STEWARD'
            WHEN 'TECHNICAL_STEWARD'    THEN 'TECHNICAL_STEWARD'
            WHEN 'DPM_TEAM'             THEN 'DPM_TEAM'
            WHEN 'DOMAIN'               THEN 'DOMAIN'
            WHEN 'SUB_DOMAIN'           THEN 'SUB_DOMAIN'
            WHEN 'SUBDOMAIN'            THEN 'SUB_DOMAIN'
            WHEN 'DATA_STATUS'           THEN 'DATA_STATUS'
            WHEN 'DATASTATUS'            THEN 'DATA_STATUS'
            WHEN 'SNOWFLAKE_DATA_STATUS' THEN 'DATA_STATUS'
            ELSE UPPER(tr.tag_name)
        END AS canonical_tag,
        NULLIF(TRIM(tr.tag_value), '') AS tag_value
    FROM snowflake_ops.account_usage.tag_references tr
    WHERE tr.object_deleted IS NULL
      AND tr.column_name IS NULL
),

tags AS (
    -- Pivot tag values to one row per table. LISTAGG preserves multiple values
    -- instead of silently discarding all but one with MAX().
    SELECT
        object_database AS database_name,
        object_schema   AS schema_name,
        object_name     AS table_name,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'BUSINESS_STEWARD'  THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'BUSINESS_STEWARD' THEN tag_value END)
            AS sf_business_steward,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'TECHNICAL_STEWARD' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'TECHNICAL_STEWARD' THEN tag_value END)
            AS sf_technical_steward,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'BDS_TEAM' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'BDS_TEAM' THEN tag_value END)
            AS sf_bds_team,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'DPM_TEAM' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'DPM_TEAM' THEN tag_value END)
            AS sf_dpm_team,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'DOMAIN' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'DOMAIN' THEN tag_value END)
            AS sf_domain,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'SUB_DOMAIN' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'SUB_DOMAIN' THEN tag_value END)
            AS sf_sub_domain,
        LISTAGG(DISTINCT CASE WHEN canonical_tag = 'DATA_STATUS' THEN tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN canonical_tag = 'DATA_STATUS' THEN tag_value END)
            AS snowflake_data_status
    FROM scoped_tags
    GROUP BY object_database, object_schema, object_name
),

access_activity AS (
    -- Last read and write per table from ACCESS_HISTORY. Reads include both
    -- underlying/base access and direct access so views are evaluated correctly.
    SELECT
        f.value:objectName::string AS object_fqn,
        MAX(ah.query_start_time)   AS last_touched,
        'READ'                     AS activity
    FROM snowflake_ops.account_usage.access_history ah,
         LATERAL FLATTEN(input => ah.base_objects_accessed) f
    WHERE ah.query_start_time >= DATEADD(day, -365, CURRENT_TIMESTAMP())
      AND f.value:objectDomain::string IN ('Table', 'View')
    GROUP BY 1

    UNION ALL

    SELECT
        f.value:objectName::string AS object_fqn,
        MAX(ah.query_start_time)   AS last_touched,
        'READ'                     AS activity
    FROM snowflake_ops.account_usage.access_history ah,
         LATERAL FLATTEN(input => ah.direct_objects_accessed) f
    WHERE ah.query_start_time >= DATEADD(day, -365, CURRENT_TIMESTAMP())
      AND f.value:objectDomain::string IN ('Table', 'View')
    GROUP BY 1

    UNION ALL

    SELECT
        f.value:objectName::string AS object_fqn,
        MAX(ah.query_start_time)   AS last_touched,
        'WRITE'                    AS activity
    FROM snowflake_ops.account_usage.access_history ah,
         LATERAL FLATTEN(input => ah.objects_modified) f
    WHERE ah.query_start_time >= DATEADD(day, -365, CURRENT_TIMESTAMP())
      AND f.value:objectDomain::string IN ('Table', 'View')
    GROUP BY 1
),

access_rollup AS (
    SELECT
        SPLIT_PART(object_fqn, '.', 1) AS database_name,
        SPLIT_PART(object_fqn, '.', 2) AS schema_name,
        SPLIT_PART(object_fqn, '.', 3) AS table_name,
        MAX(CASE WHEN activity = 'READ'  THEN last_touched END) AS last_read,
        MAX(CASE WHEN activity = 'WRITE' THEN last_touched END) AS last_write
    FROM access_activity
    GROUP BY 1, 2, 3
),

load_activity AS (
    -- Last successful COPY/Snowpipe load per table.
    SELECT
        table_catalog_name AS database_name,
        table_schema_name  AS schema_name,
        table_name,
        MAX(last_load_time) AS last_load
    FROM snowflake_ops.account_usage.copy_history
    GROUP BY 1, 2, 3
),

joined AS (
    SELECT
        t.database_name,
        t.schema_name,
        t.table_name,
        t.table_type,
        t.table_owner AS snowflake_table_owner,
        t.row_count,
        t.bytes,

        g.sf_domain,
        g.sf_sub_domain,
        g.sf_business_steward,
        g.sf_technical_steward,
        g.sf_bds_team,
        g.sf_dpm_team,
        COALESCE(g.snowflake_data_status, 'ACTIVE') AS snowflake_data_status,

        CASE
            WHEN NULLIF(g.sf_dpm_team, '') IS NOT NULL
              OR NULLIF(g.sf_bds_team, '') IS NOT NULL
                THEN 'KNOWN'
            ELSE 'ORPHANED'
        END AS ownership_status,

        CASE
            WHEN NULLIF(g.sf_dpm_team, '') IS NOT NULL
             AND NULLIF(g.sf_bds_team, '') IS NOT NULL
                THEN 'DPM_TEAM + BDS_TEAM'
            WHEN NULLIF(g.sf_dpm_team, '') IS NOT NULL
                THEN 'DPM_TEAM_ONLY'
            WHEN NULLIF(g.sf_bds_team, '') IS NOT NULL
                THEN 'BDS_TEAM_ONLY'
            WHEN NULLIF(g.sf_business_steward, '') IS NOT NULL
                THEN 'BUSINESS_STEWARD_ONLY'
            WHEN NULLIF(g.sf_technical_steward, '') IS NOT NULL
                THEN 'TECHNICAL_STEWARD_ONLY'
            WHEN NULLIF(t.table_owner, '') IS NOT NULL
                THEN 'SNOWFLAKE_TABLE_OWNER_ONLY'
            ELSE 'NONE'
        END AS ownership_source,

        a.last_read,
        a.last_write,
        l.last_load,
        t.last_altered,
        NULLIF(
            GREATEST(
                COALESCE(a.last_read,    '1900-01-01'::timestamp_ltz),
                COALESCE(a.last_write,   '1900-01-01'::timestamp_ltz),
                COALESCE(l.last_load,    '1900-01-01'::timestamp_ltz),
                COALESCE(t.last_altered, '1900-01-01'::timestamp_ltz)
            ),
            '1900-01-01'::timestamp_ltz
        ) AS last_activity_ts
    FROM tbls t
    LEFT JOIN tags g
      ON g.database_name = t.database_name
     AND g.schema_name   = t.schema_name
     AND g.table_name    = t.table_name
    LEFT JOIN access_rollup a
      ON a.database_name = t.database_name
     AND a.schema_name   = t.schema_name
     AND a.table_name    = t.table_name
    LEFT JOIN load_activity l
      ON l.database_name = t.database_name
     AND l.schema_name   = t.schema_name
     AND l.table_name    = t.table_name

    -- Test scope only: retain every table tagged to the Information Technology
    -- L1 domain. EXISTS handles assets that carry more than one DOMAIN tag.
    WHERE EXISTS (
        SELECT 1
        FROM scoped_tags domain_tag
        WHERE domain_tag.object_database = t.database_name
          AND domain_tag.object_schema   = t.schema_name
          AND domain_tag.object_name     = t.table_name
          AND domain_tag.canonical_tag   = 'DOMAIN'
          AND (
                UPPER(TRIM(domain_tag.tag_value)) = 'INFORMATION TECHNOLOGY'
                OR UPPER(TRIM(domain_tag.tag_value)) LIKE 'INFORMATION TECHNOLOGY.%'
          )
    )
)

SELECT
    'BT-SNOWFLAKE-PRD.' || database_name || '.' || schema_name || '.' || table_name AS table_fqn,
    database_name,
    schema_name,
    table_name,
    table_type,

    -- Native and governance ownership details.
    snowflake_table_owner,
    snowflake_data_status,
    sf_dpm_team,
    sf_bds_team,
    sf_business_steward,
    sf_technical_steward,
    ownership_status,
    ownership_source,

    sf_domain,
    sf_sub_domain,
    row_count,
    bytes,

    -- Raw activity signals.
    last_read,
    last_write,
    last_load,
    last_altered,

    -- LAST_ACTIVITY_TS remains operational context. Staleness is based only on
    -- qualifying reads; writes, loads, and DDL changes do not reset the clock.
    last_activity_ts,
    DATEDIFF(day, last_read, CURRENT_TIMESTAMP()) AS days_since_activity,
    (
        last_read IS NULL
        OR DATEDIFF(day, last_read, CURRENT_TIMESTAMP()) >= 30
    ) AS is_stale_30,
    (
        last_read IS NULL
        OR DATEDIFF(day, last_read, CURRENT_TIMESTAMP()) >= 90
    ) AS is_stale_90,
    (
        last_read IS NULL
        OR DATEDIFF(day, last_read, CURRENT_TIMESTAMP()) >= 180
    ) AS is_stale_180,
    (
        last_read IS NULL
        OR DATEDIFF(day, last_read, CURRENT_TIMESTAMP()) >= 365
    ) AS is_stale_365,

    CURRENT_TIMESTAMP() AS source_snapshot_at
FROM joined
ORDER BY days_since_activity DESC NULLS FIRST;
