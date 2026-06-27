create table if not exists catalog_counts (
  entry_key text primary key,
  install_count integer not null default 0,
  updated_at_ms integer not null
);

create table if not exists catalog_entries (
  entry_key text primary key,
  provider text not null,
  repository text not null,
  source_path text not null,
  caplet_id text not null,
  resolved_revision text,
  content_hash text,
  entry_json text not null,
  updated_at_ms integer not null
);

create table if not exists catalog_signal_dedupe (
  entry_key text primary key,
  provider text not null,
  repository text not null,
  accepted_at_ms integer not null
);

create table if not exists catalog_signal_repository_windows (
  provider text not null,
  repository text not null,
  window_start_ms integer not null,
  accepted_count integer not null default 0,
  primary key (provider, repository, window_start_ms)
);

create table if not exists catalog_suppressions (
  entry_key text primary key,
  reason text not null,
  suppressed_at text not null
);

create index if not exists catalog_counts_rank_idx on catalog_counts (install_count desc);
create index if not exists catalog_entries_repository_idx on catalog_entries (provider, repository);
create index if not exists catalog_signal_repository_windows_time_idx on catalog_signal_repository_windows (window_start_ms);
