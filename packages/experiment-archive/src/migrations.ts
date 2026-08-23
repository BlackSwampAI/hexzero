export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: 'initial durable experiment archive',
    sql: `
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        provider_mode TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        scenario_json TEXT,
        model_configuration_json TEXT,
        behavior_configuration_json TEXT,
        objective_version TEXT,
        decision_contract_version TEXT NOT NULL,
        observation_contract_version TEXT NOT NULL,
        retention_limit INTEGER NOT NULL,
        total_completed_turns INTEGER NOT NULL,
        retained_turns INTEGER NOT NULL,
        first_retained_turn INTEGER,
        last_retained_turn INTEGER,
        dropped_records INTEGER NOT NULL,
        retention_complete INTEGER NOT NULL CHECK (retention_complete IN (0, 1)),
        requested_range_extends_beyond_retention INTEGER NOT NULL CHECK (requested_range_extends_beyond_retention IN (0, 1)),
        source_metrics_json TEXT,
        source_territory_json TEXT,
        source_alliances_json TEXT,
        metric_inconsistencies_json TEXT NOT NULL DEFAULT '[]'
      ) STRICT;

      CREATE TABLE source_exports (
        sha256 TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        source_metrics_json TEXT,
        retention_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX source_exports_experiment_idx ON source_exports(experiment_id, imported_at);

      CREATE TABLE agents (
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        model_id TEXT,
        reasoning_profile TEXT,
        personality_id TEXT,
        strategy_id TEXT,
        personality TEXT,
        is_patient_zero INTEGER NOT NULL DEFAULT 0 CHECK (is_patient_zero IN (0, 1)),
        initial_agent_json TEXT,
        current_agent_json TEXT,
        PRIMARY KEY (experiment_id, agent_id)
      ) STRICT;
      CREATE INDEX agents_patient_zero_idx ON agents(experiment_id, is_patient_zero);

      CREATE TABLE map_cells (
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        cell_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        initial_state TEXT,
        initial_controller_agent_id TEXT,
        current_state TEXT,
        current_controller_agent_id TEXT,
        initial_json TEXT,
        current_json TEXT,
        PRIMARY KEY (experiment_id, cell_id)
      ) STRICT;
      CREATE INDEX map_cells_current_controller_idx ON map_cells(experiment_id, current_controller_agent_id);

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        action TEXT,
        action_accepted INTEGER,
        action_reason TEXT,
        summary TEXT,
        world_action_summary TEXT,
        communication_summary TEXT,
        diplomacy_summary TEXT,
        position_before TEXT,
        position_after TEXT,
        move_direction TEXT,
        inbound_communication_since_previous_move INTEGER CHECK (inbound_communication_since_previous_move IN (0, 1)),
        model_id TEXT,
        reasoning_profile TEXT,
        personality_id TEXT,
        strategy_id TEXT,
        latency_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        reasoning_tokens INTEGER,
        cached_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_credits REAL,
        observation_size_bytes INTEGER,
        observation_json TEXT,
        world_action_json TEXT,
        world_action_result_json TEXT,
        communication_result_json TEXT,
        diplomacy_result_json TEXT,
        failure_json TEXT,
        UNIQUE (experiment_id, turn_number)
      ) STRICT;
      CREATE INDEX turns_experiment_agent_idx ON turns(experiment_id, agent_id, turn_number);
      CREATE INDEX turns_experiment_outcome_idx ON turns(experiment_id, outcome, turn_number);
      CREATE INDEX turns_experiment_action_idx ON turns(experiment_id, action, turn_number);

      CREATE TABLE model_attempts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_profile TEXT NOT NULL,
        accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
        failure_code TEXT,
        failure_message TEXT,
        validation_codes_json TEXT,
        latency_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        reasoning_tokens INTEGER,
        cached_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_credits REAL,
        UNIQUE (turn_id, attempt_number)
      ) STRICT;
      CREATE INDEX model_attempts_experiment_failure_idx ON model_attempts(experiment_id, failure_code, turn_number);

      CREATE TABLE communications (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        sender_agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        recipient_agent_id TEXT,
        message TEXT NOT NULL,
        distance REAL,
        occurred_at TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        rejection_details TEXT,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX communications_experiment_channel_idx ON communications(experiment_id, channel, turn_number, id);
      CREATE INDEX communications_sender_idx ON communications(experiment_id, sender_agent_id, turn_number);
      CREATE INDEX communications_recipient_idx ON communications(experiment_id, recipient_agent_id, turn_number);

      CREATE TABLE communication_recipients (
        communication_id TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
        recipient_agent_id TEXT NOT NULL,
        PRIMARY KEY (communication_id, recipient_agent_id)
      ) STRICT;

      CREATE TABLE diplomacy_attempts (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        recipient_agent_id TEXT,
        proposal_id TEXT,
        accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
        rejection_reason TEXT,
        rejection_details TEXT,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX diplomacy_attempts_experiment_idx ON diplomacy_attempts(experiment_id, turn_number, type, accepted);
      CREATE INDEX diplomacy_attempts_rejection_idx ON diplomacy_attempts(experiment_id, rejection_reason, turn_number);

      CREATE TABLE alliance_events (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX alliance_events_experiment_type_idx ON alliance_events(experiment_id, type, turn_number, id);
      CREATE INDEX alliance_events_reason_idx ON alliance_events(experiment_id, reason, turn_number);

      CREATE TABLE world_events (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        cell_id TEXT,
        previous_controller_agent_id TEXT,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX world_events_experiment_type_idx ON world_events(experiment_id, type, turn_number, id);

      CREATE TABLE configuration_events (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        effective_turn INTEGER,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX configuration_events_experiment_idx ON configuration_events(experiment_id, occurred_at, id);

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('transcript', 'observation', 'hypothesis', 'decision', 'implementation-note', 'experiment-finding')),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'deferred', 'superseded')),
        provenance TEXT NOT NULL,
        superseded_note_id TEXT REFERENCES notes(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX notes_status_type_idx ON notes(status, type, updated_at DESC, id);

      CREATE TABLE note_tags (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
      ) STRICT;
      CREATE INDEX note_tags_tag_idx ON note_tags(tag, note_id);

      CREATE TABLE note_experiments (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, experiment_id)
      ) STRICT;
      CREATE INDEX note_experiments_experiment_idx ON note_experiments(experiment_id, note_id);

      CREATE VIRTUAL TABLE notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        body,
        tags,
        tokenize = 'unicode61'
      );
    `,
  },
  {
    version: 2,
    description: 'schema-v10 simultaneous tick attribution',
    sql: `
      ALTER TABLE turns ADD COLUMN tick_number INTEGER;
      ALTER TABLE turns ADD COLUMN tick_position INTEGER;
      ALTER TABLE turns ADD COLUMN virtual_time TEXT;
      ALTER TABLE turns ADD COLUMN tick_interval_minutes INTEGER;
      CREATE INDEX turns_experiment_tick_idx ON turns(experiment_id, tick_number, tick_position);
    `,
  },
  {
    version: 3,
    description: 'deterministic simulated-player pressure activity',
    sql: `
      ALTER TABLE experiments ADD COLUMN simulated_player_metrics_json TEXT;
      CREATE TABLE simulated_player_activity (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        tick_number INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        profile TEXT NOT NULL,
        type TEXT NOT NULL,
        from_cell_id TEXT,
        to_cell_id TEXT,
        cell_id TEXT,
        previous_controller_agent_id TEXT,
        blocking_agent_id TEXT,
        source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX simulated_player_activity_experiment_idx
        ON simulated_player_activity(experiment_id, tick_number, type, id);
    `,
  },
] as const;
