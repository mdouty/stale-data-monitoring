/*******************************************************************************
 * Snowflake Information Technology Asset Inventory — Raw Activity Evidence
 *
 * Purpose:
 *   Return one row for every current in-scope table or view. The application,
 *   rather than this query, calculates read staleness and lifecycle changes.
 *
 * Application contract:
 *   - LAST_READ is qualifying consumption evidence from BASE_OBJECTS_ACCESSED
 *     or DIRECT_OBJECTS_ACCESSED.
 *   - A NULL LAST_READ means no qualifying read was found in the available
 *     365-day ACCESS_HISTORY window. It does not prove the object was never read.
 *   - The application uses OBJECT_CREATED_DATE as the grace-period clock when
 *     LAST_READ is NULL.
 *   - LAST_WRITE, LAST_LOAD, and LAST_ALTERED are operational context only and
 *     do not reset read staleness.
 *   - No stale flags, elapsed-day calculations, activity statuses, filtering,
 *     result limits, or lifecycle conclusions are produced by this query.
 *
 * Performance:
 *   - ACCESS_HISTORY is scanned once for the available 365-day read window.
 *   - Write evidence is limited to the most recent 180 days.
 *   - Object IDs are joined to the scoped inventory after flattening.
 *   - No global ORDER BY is performed.
 *******************************************************************************/

WITH params AS (
    SELECT
        CURRENT_TIMESTAMP() AS source_snapshot_at,
        DATEADD(day, -180, CURRENT_TIMESTAMP()) AS operational_cutoff,
        DATEADD(day, -365, CURRENT_TIMESTAMP()) AS history_cutoff
),

tbls AS (
    SELECT
        table_id,
        table_catalog AS database_name,
        table_schema AS schema_name,
        table_name,
        table_type,
        table_owner,
        row_count,
        bytes,
        created,
        last_altered
    FROM snowflake_ops.account_usage.tables
    WHERE deleted IS NULL
      AND table_type IN ('BASE TABLE', 'VIEW', 'MATERIALIZED VIEW')
),

scoped_tags AS (
    SELECT
        tr.object_database,
        tr.object_schema,
        tr.object_name,
        CASE UPPER(tr.tag_name)
            WHEN 'BIZ_DATASTEWARD_TEAM'  THEN 'BDS_TEAM'
            WHEN 'BDS_TEAM'              THEN 'BDS_TEAM'
            WHEN 'BUSINESS_STEWARD'      THEN 'BUSINESS_STEWARD'
            WHEN 'TECHNICAL_STEWARD'     THEN 'TECHNICAL_STEWARD'
            WHEN 'DPM_TEAM'              THEN 'DPM_TEAM'
            WHEN 'DOMAIN'                THEN 'DOMAIN'
            WHEN 'SUB_DOMAIN'            THEN 'SUB_DOMAIN'
            WHEN 'SUBDOMAIN'             THEN 'SUB_DOMAIN'
            WHEN 'DATA_STATUS'           THEN 'DATA_STATUS'
            WHEN 'DATASTATUS'             THEN 'DATA_STATUS'
            WHEN 'SNOWFLAKE_DATA_STATUS' THEN 'DATA_STATUS'
            ELSE UPPER(tr.tag_name)
        END AS canonical_tag,
        NULLIF(TRIM(tr.tag_value), '') AS tag_value
    FROM snowflake_ops.account_usage.tag_references tr
    WHERE tr.object_deleted IS NULL
      AND tr.column_name IS NULL
      AND UPPER(tr.tag_name) IN (
            'BIZ_DATASTEWARD_TEAM',
            'BDS_TEAM',
            'BUSINESS_STEWARD',
            'TECHNICAL_STEWARD',
            'DPM_TEAM',
            'DOMAIN',
            'SUB_DOMAIN',
            'SUBDOMAIN',
            'DATA_STATUS',
            'DATASTATUS',
            'SNOWFLAKE_DATA_STATUS'
      )
),

/* Replace this CTE when an authoritative DPS domain inventory is available. */
domain_scope AS (
    SELECT DISTINCT
        object_database AS database_name,
        object_schema AS schema_name,
        object_name
    FROM scoped_tags
    WHERE canonical_tag = 'DOMAIN'
      AND (
            UPPER(TRIM(tag_value)) = 'INFORMATION TECHNOLOGY'
            OR UPPER(TRIM(tag_value)) LIKE 'INFORMATION TECHNOLOGY.%'
      )
),

tags AS (
    SELECT
        tag_row.object_database AS database_name,
        tag_row.object_schema AS schema_name,
        tag_row.object_name AS table_name,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'BUSINESS_STEWARD' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'BUSINESS_STEWARD' THEN tag_row.tag_value END)
            AS sf_business_steward,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'TECHNICAL_STEWARD' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'TECHNICAL_STEWARD' THEN tag_row.tag_value END)
            AS sf_technical_steward,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'BDS_TEAM' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'BDS_TEAM' THEN tag_row.tag_value END)
            AS sf_bds_team,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'DPM_TEAM' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'DPM_TEAM' THEN tag_row.tag_value END)
            AS sf_dpm_team,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'DOMAIN' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'DOMAIN' THEN tag_row.tag_value END)
            AS sf_domain,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'SUB_DOMAIN' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'SUB_DOMAIN' THEN tag_row.tag_value END)
            AS sf_sub_domain,
        LISTAGG(DISTINCT CASE WHEN tag_row.canonical_tag = 'DATA_STATUS' THEN tag_row.tag_value END, ', ')
            WITHIN GROUP (ORDER BY CASE WHEN tag_row.canonical_tag = 'DATA_STATUS' THEN tag_row.tag_value END)
            AS snowflake_data_status
    FROM scoped_tags tag_row
    INNER JOIN domain_scope domain_row
      ON domain_row.database_name = tag_row.object_database
     AND domain_row.schema_name = tag_row.object_schema
     AND domain_row.object_name = tag_row.object_name
    GROUP BY
        tag_row.object_database,
        tag_row.object_schema,
        tag_row.object_name
),

objects_in_scope AS (
    SELECT
        table_row.table_id,
        table_row.database_name,
        table_row.schema_name,
        table_row.table_name,
        table_row.table_type,
        table_row.table_owner AS snowflake_table_owner,
        table_row.row_count,
        table_row.bytes,
        table_row.created AS object_created_date,
        table_row.last_altered,
        tag_values.sf_domain,
        tag_values.sf_sub_domain,
        tag_values.sf_business_steward,
        tag_values.sf_technical_steward,
        tag_values.sf_bds_team,
        tag_values.sf_dpm_team,
        COALESCE(tag_values.snowflake_data_status, 'ACTIVE') AS snowflake_data_status,
        CASE
            WHEN NULLIF(tag_values.sf_dpm_team, '') IS NOT NULL
              OR NULLIF(tag_values.sf_bds_team, '') IS NOT NULL
                THEN 'KNOWN'
            ELSE 'ORPHANED'
        END AS ownership_status,
        CASE
            WHEN NULLIF(tag_values.sf_dpm_team, '') IS NOT NULL
             AND NULLIF(tag_values.sf_bds_team, '') IS NOT NULL
                THEN 'DPM_TEAM + BDS_TEAM'
            WHEN NULLIF(tag_values.sf_dpm_team, '') IS NOT NULL
                THEN 'DPM_TEAM_ONLY'
            WHEN NULLIF(tag_values.sf_bds_team, '') IS NOT NULL
                THEN 'BDS_TEAM_ONLY'
            WHEN NULLIF(tag_values.sf_business_steward, '') IS NOT NULL
                THEN 'BUSINESS_STEWARD_ONLY'
            WHEN NULLIF(tag_values.sf_technical_steward, '') IS NOT NULL
                THEN 'TECHNICAL_STEWARD_ONLY'
            WHEN NULLIF(table_row.table_owner, '') IS NOT NULL
                THEN 'SNOWFLAKE_TABLE_OWNER_ONLY'
            ELSE 'NONE'
        END AS ownership_source
    FROM tbls table_row
    INNER JOIN domain_scope domain_row
      ON domain_row.database_name = table_row.database_name
     AND domain_row.schema_name = table_row.schema_name
     AND domain_row.object_name = table_row.table_name
    LEFT JOIN tags tag_values
      ON tag_values.database_name = table_row.database_name
     AND tag_values.schema_name = table_row.schema_name
     AND tag_values.table_name = table_row.table_name
),

/*
 * ACCESS_HISTORY is authorized in SNOWFLAKE_OPS. Keep this boundary isolated so
 * AGGREGATE_ACCESS_HISTORY can be substituted later if it is granted.
 */
access_history_window AS (
    SELECT
        history_row.query_start_time AS activity_time,
        history_row.base_objects_accessed,
        history_row.direct_objects_accessed,
        history_row.objects_modified
    FROM snowflake_ops.account_usage.access_history history_row
    CROSS JOIN params parameter_row
    WHERE history_row.query_start_time > parameter_row.history_cutoff
),

read_events AS (
    SELECT
        flattened_read.value:"objectId"::NUMBER AS object_id,
        history_row.activity_time
    FROM access_history_window history_row,
         LATERAL FLATTEN(
             input => ARRAY_CAT(
                 COALESCE(history_row.base_objects_accessed, ARRAY_CONSTRUCT()),
                 COALESCE(history_row.direct_objects_accessed, ARRAY_CONSTRUCT())
             )
         ) flattened_read
    WHERE flattened_read.value:"objectDomain"::STRING IN ('Table', 'View')
),

read_activity AS (
    SELECT
        scoped_object.table_id AS object_id,
        MAX(read_event.activity_time) AS last_read
    FROM read_events read_event
    INNER JOIN objects_in_scope scoped_object
      ON scoped_object.table_id = read_event.object_id
    GROUP BY scoped_object.table_id
),

write_events AS (
    SELECT
        flattened_write.value:"objectId"::NUMBER AS object_id,
        history_row.activity_time
    FROM access_history_window history_row,
         LATERAL FLATTEN(input => history_row.objects_modified) flattened_write
    WHERE history_row.activity_time > (SELECT operational_cutoff FROM params)
      AND flattened_write.value:"objectDomain"::STRING IN ('Table', 'View')
),

write_activity AS (
    SELECT
        scoped_object.table_id AS object_id,
        MAX(write_event.activity_time) AS last_write
    FROM write_events write_event
    INNER JOIN objects_in_scope scoped_object
      ON scoped_object.table_id = write_event.object_id
    GROUP BY scoped_object.table_id
),

load_activity AS (
    SELECT
        scoped_object.table_id AS object_id,
        MAX(copy_row.last_load_time) AS last_load
    FROM snowflake_ops.account_usage.copy_history copy_row
    INNER JOIN objects_in_scope scoped_object
      ON scoped_object.database_name = copy_row.table_catalog_name
     AND scoped_object.schema_name = copy_row.table_schema_name
     AND scoped_object.table_name = copy_row.table_name
    CROSS JOIN params parameter_row
    WHERE copy_row.last_load_time > parameter_row.operational_cutoff
    GROUP BY scoped_object.table_id
),

raw_evidence AS (
    SELECT
        scoped_object.*,
        read_values.last_read,
        write_values.last_write,
        load_values.last_load
    FROM objects_in_scope scoped_object
    LEFT JOIN read_activity read_values
      ON read_values.object_id = scoped_object.table_id
    LEFT JOIN write_activity write_values
      ON write_values.object_id = scoped_object.table_id
    LEFT JOIN load_activity load_values
      ON load_values.object_id = scoped_object.table_id
)

/* Keep the complete population; the application performs all classifications. */
SELECT
    'BT-SNOWFLAKE-PRD.' || evidence.database_name || '.' || evidence.schema_name || '.' || evidence.table_name AS table_fqn,
    evidence.table_id,
    evidence.database_name,
    evidence.schema_name,
    evidence.table_name,
    evidence.table_type,
    evidence.snowflake_table_owner,
    evidence.snowflake_data_status,
    evidence.sf_dpm_team,
    evidence.sf_bds_team,
    evidence.sf_business_steward,
    evidence.sf_technical_steward,
    evidence.ownership_status,
    evidence.ownership_source,
    evidence.sf_domain,
    evidence.sf_sub_domain,
    evidence.row_count,
    evidence.bytes,
    evidence.object_created_date,
    evidence.last_read,
    evidence.last_write,
    evidence.last_load,
    evidence.last_altered,
    parameter_row.source_snapshot_at
FROM raw_evidence evidence
CROSS JOIN params parameter_row;
