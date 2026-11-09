-- Both preview and deletion resolve the same original, confirmation and report dependencies.
CREATE OR REPLACE FUNCTION intake_deletion_scope(p_event uuid, p_batch uuid, p_file uuid)
RETURNS TABLE(teams uuid[], batches uuid[], files uuid[], submissions uuid[], reports uuid[]) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE originals AS (
        SELECT f.id FROM intake_file f JOIN intake_batch b ON b.id=f.batch_id
        WHERE b.event_id=p_event AND (p_batch IS NULL OR b.id=p_batch) AND (p_file IS NULL OR f.id=p_file)
    ), receipts AS (
        SELECT b.id FROM intake_batch b WHERE b.event_id=p_event AND (p_batch IS NULL OR b.id=p_batch)
        AND (p_file IS NULL OR NOT EXISTS (SELECT FROM intake_file WHERE batch_id=b.id AND id<>p_file))
    ), versions AS (
        SELECT s.id FROM team_submission s JOIN award_team t ON t.id=s.team_id
        WHERE t.event_id=p_event AND (p_batch IS NULL
            OR EXISTS (SELECT FROM team_submission_file sf WHERE sf.submission_id=s.id AND sf.file_id IN (SELECT id FROM originals))
            OR EXISTS (SELECT FROM intake_team_confirmation c WHERE c.submission_id=s.id
                AND c.state<>'superseded' AND c.batch_id IN (SELECT id FROM receipts))
            -- An identical upload may have confirmed a version whose stored originals belong to an earlier receipt.
            OR EXISTS (SELECT FROM intake_team_confirmation c JOIN intake_file_state f ON f.batch_id=c.batch_id AND f.team_id=c.team_id
                JOIN team_submission_file sf ON sf.submission_id=c.submission_id JOIN intake_file source ON source.id=sf.file_id
                WHERE c.submission_id=s.id AND c.state<>'superseded' AND f.id=p_file AND source.sha256=f.sha256))
    ), related(id) AS (
        SELECT id FROM award_report WHERE event_id=p_event AND (p_batch IS NULL OR selection && ARRAY(SELECT id FROM versions))
        UNION SELECT r.id FROM award_report r JOIN related parent ON parent.id=r.parent WHERE r.event_id=p_event
    )
    SELECT ARRAY(SELECT id FROM award_team WHERE p_batch IS NULL AND event_id=p_event ORDER BY id),
           ARRAY(SELECT id FROM receipts ORDER BY id), ARRAY(SELECT id FROM originals ORDER BY id),
           ARRAY(SELECT id FROM versions ORDER BY id), ARRAY(SELECT id FROM related ORDER BY id)
    WHERE EXISTS (SELECT FROM award_event WHERE id=p_event)
        AND (p_batch IS NULL OR EXISTS (SELECT FROM intake_batch WHERE id=p_batch AND event_id=p_event))
        AND (p_file IS NULL OR EXISTS (SELECT FROM originals));
$$;

CREATE OR REPLACE FUNCTION intake_deletion_preview(p_event uuid, p_batch uuid, p_file uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE AS $$
    SELECT detail || jsonb_build_object('token',encode(sha256(convert_to(
        jsonb_build_array(p_event,p_batch,p_file,s.teams,s.batches,s.files,detail)::text,'UTF8')),'hex'))
    FROM intake_deletion_scope(p_event,p_batch,p_file) s
    CROSS JOIN LATERAL (SELECT jsonb_build_object(
        'team_count',cardinality(s.teams),'batch_count',cardinality(s.batches),'file_count',cardinality(s.files),
        'reviews',ARRAY(SELECT jsonb_build_object('id',v.id,'team_name',t.name,'intake_number',t.intake_number,
            'version',v.version,'state',v.state,'verdict',v.verdict,'decision',v.decision)
            FROM ops_submission v JOIN award_team t ON t.id=v.team_id WHERE v.id=ANY(s.submissions)
            ORDER BY t.intake_number NULLS LAST,t.name,t.id,v.version),
        'reports',ARRAY(SELECT jsonb_build_object('id',r.id,'version',r.version,'state',r.state,'edited',r.parent IS NOT NULL)
            FROM award_report r WHERE r.id=ANY(s.reports) ORDER BY r.version,r.id)
    ) AS detail) display;
$$;

-- The HTTP transaction already holds the requesting staff member's event grant.
CREATE OR REPLACE FUNCTION delete_intake_data(p_event uuid, p_batch uuid, p_file uuid, p_expected text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
    batches uuid[];
    files uuid[];
    submissions uuid[];
    reports uuid[];
BEGIN
    -- Serialize with staff edits and uploads, preparation, confirmation, and report creation.
    PERFORM FROM event_staff WHERE event_id=p_event ORDER BY login FOR UPDATE NOWAIT;
    PERFORM FROM award_event WHERE id=p_event FOR UPDATE NOWAIT;
    PERFORM FROM intake_batch WHERE event_id=p_event ORDER BY id FOR UPDATE NOWAIT;
    PERFORM FROM award_team WHERE event_id=p_event ORDER BY id FOR NO KEY UPDATE NOWAIT;
    SELECT s.batches,s.files,s.submissions,s.reports INTO batches,files,submissions,reports
        FROM intake_deletion_scope(p_event,p_batch,p_file) s;
    IF NOT FOUND THEN RETURN 404; END IF;
    PERFORM FROM intake_file WHERE id=ANY(files) ORDER BY id FOR UPDATE NOWAIT;

    -- A claimant either finishes first or cannot acquire its row while deletion commits.
    PERFORM FROM review_job WHERE submission_id=ANY(submissions) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM FROM studio_execution e JOIN review_job j ON j.id=e.job_id WHERE j.submission_id=ANY(submissions)
        ORDER BY e.job_id FOR UPDATE OF e NOWAIT;
    PERFORM FROM review_mail WHERE submission_id=ANY(submissions) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM FROM award_report WHERE id=ANY(reports) ORDER BY id FOR UPDATE NOWAIT;
    IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM
        (SELECT '"' || (preview->>'token') || '"' FROM intake_deletion_preview(p_event,p_batch,p_file) preview) THEN
        RETURN 412;
    END IF;
    IF EXISTS (SELECT FROM review_job j LEFT JOIN studio_execution e ON e.job_id=j.id WHERE j.submission_id=ANY(submissions)
               AND (e.occupies_slot OR (j.work_state='running' AND j.lease_until>clock_timestamp())
                    OR (j.work_state IN ('running','queued') AND j.studio_job_id IS NOT NULL
                        AND coalesce(e.phase,'polling') NOT IN ('superseded','done','failed'))))
       OR EXISTS (SELECT FROM review_mail WHERE submission_id=ANY(submissions) AND state='sending')
       OR EXISTS (SELECT FROM award_report WHERE id=ANY(reports) AND
                  (state IN ('building','verifying') OR (state='printing' AND print_until>clock_timestamp()))) THEN
        RETURN 409;
    END IF;

    INSERT INTO intake_cache_cleanup(item_id,batch_id) SELECT id,batch_id FROM intake_file WHERE id=ANY(files);
    INSERT INTO intake_cache_cleanup(item_id) SELECT id FROM review_mail WHERE submission_id=ANY(submissions);

    IF p_batch IS NOT NULL THEN
        INSERT INTO withdrawn_intake_request(event_id,request_key)
            SELECT event_id,request_key FROM intake_batch WHERE id=p_batch ON CONFLICT DO NOTHING;
        UPDATE award_event SET deleted_report_version=greatest(deleted_report_version,
            (SELECT max(version) FROM award_report WHERE id=ANY(reports))) WHERE id=p_event;
        UPDATE award_team t SET deleted_submission_version=greatest(t.deleted_submission_version,s.highest)
            FROM (SELECT team_id,max(version) highest FROM team_submission WHERE id=ANY(submissions) GROUP BY team_id) s
            WHERE s.team_id=t.id;
        UPDATE intake_batch b SET assignment_revision=assignment_revision+1
            WHERE b.event_id=p_event AND b.id<>ALL(batches) AND (b.id=p_batch OR b.base_submission=ANY(submissions)
                OR b.inherited_files && files OR EXISTS (SELECT FROM intake_team_confirmation c
                    WHERE c.batch_id=b.id AND c.submission_id=ANY(submissions)));
        -- A correction without a surviving confirmed version needs staff review when its base disappears.
        UPDATE intake_preparation p SET state='conflict', reviewed_by=NULL, reviewed_at=NULL FROM intake_batch b
            WHERE p.batch_id=b.id AND b.id<>ALL(batches) AND b.base_submission=ANY(submissions)
            AND NOT EXISTS (SELECT FROM intake_team_confirmation c WHERE c.batch_id=b.id
                AND c.submission_id<>ALL(submissions) AND c.state IN ('confirmed','superseded'));
    END IF;
    -- Preserve the exact carried-forward files of surviving corrections, including their order.
    UPDATE intake_batch b SET inherited_files=ARRAY(SELECT sf.file_id FROM team_submission_file sf
            WHERE sf.submission_id=b.base_submission AND sf.file_id<>ALL(b.replaced) AND sf.file_id<>ALL(files)
            ORDER BY sf.position), base_submission=NULL, replaced='{}'
        WHERE b.event_id=p_event AND b.base_submission=ANY(submissions);
    UPDATE intake_batch b SET inherited_files=ARRAY(SELECT f FROM unnest(b.inherited_files) WITH ORDINALITY AS x(f,ord)
        WHERE f<>ALL(files) ORDER BY ord) WHERE b.event_id=p_event AND b.inherited_files && files;
    UPDATE award_team SET email_confirmed_submission=NULL WHERE event_id=p_event AND email_confirmed_submission=ANY(submissions);

    DELETE FROM award_report WHERE id=ANY(reports);
    DELETE FROM workflow_audit WHERE submission_id=ANY(submissions);
    DELETE FROM review_mail WHERE submission_id=ANY(submissions);
    DELETE FROM review_resolution WHERE submission_id=ANY(submissions);
    DELETE FROM studio_execution e USING review_job j WHERE j.id=e.job_id AND j.submission_id=ANY(submissions);
    DELETE FROM review_job WHERE submission_id=ANY(submissions);
    DELETE FROM intake_team_confirmation WHERE submission_id=ANY(submissions) OR batch_id=ANY(batches);
    DELETE FROM team_submission_file WHERE submission_id=ANY(submissions);
    DELETE FROM team_submission WHERE id=ANY(submissions);
    DELETE FROM document_edit_version WHERE file_id=ANY(files);
    DELETE FROM original_analysis WHERE file_id=ANY(files);
    DELETE FROM file_preparation_log WHERE file_id=ANY(files);
    DELETE FROM intake_assignment_exclusion WHERE file_id=ANY(files);
    DELETE FROM intake_file_assignment WHERE file_id=ANY(files);
    DELETE FROM intake_file WHERE id=ANY(files);
    DELETE FROM intake_preparation WHERE batch_id=ANY(batches);
    DELETE FROM intake_batch WHERE id=ANY(batches);
    IF p_batch IS NULL THEN
        DELETE FROM award_team WHERE event_id=p_event;
        DELETE FROM award_event WHERE id=p_event;
    END IF;
    RETURN 204;
END;
$$;

CREATE OR REPLACE FUNCTION delete_intake_data(p_event uuid, p_batch uuid, p_file uuid)
RETURNS integer LANGUAGE sql AS $$ SELECT delete_intake_data(p_event,p_batch,p_file,NULL::text); $$;
