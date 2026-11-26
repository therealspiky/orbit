// Types and small hooks for the handoff-spec features (clips, people, promises, recall, research, credits, metrics).
import { useQuery } from '@tanstack/react-query';
import { check, supabase } from './supabase';

export interface Clip {
  id: string; brief_id: string; source_id: string; social_index: number | null; segment_start: number; segment_end: number;
  start_ms: number; end_ms: number; aspect_ratio: '9:16' | '16:9' | '1:1'; caption_mode: 'burned' | 'sidecar';
  headline: string; caption_text: string; transcript_text: string; caption_differs: boolean;
  status: 'draft' | 'queued' | 'rendering' | 'rendered' | 'failed'; revision: number; rendered_revision: number | null;
  render_error: string | null; video_path: string | null; srt_path: string | null; vtt_path: string | null;
  duration_ms: number | null; music_flag: boolean; music_ranges: { start_ms: number; end_ms: number }[]; updated_at: string;
}
export interface Person {
  id: string; org_id: string; user_id: string | null; display_name: string; kind: 'staff' | 'guest' | 'public_figure' | 'other';
  title: string | null; affiliation: string | null; bio: string | null; languages: string[]; expertise_tags: string[];
  consent_status: string; verification_status: string; anonymised_at: string | null; created_at: string;
}
export interface RecallHit {
  source_id: string; segment_idx: number; quote: string; start_ms: number | null; end_ms: number | null; speaker: string | null;
  person_id: string | null; person_name: string | null; source_title: string; show_id: string | null; show_name: string | null;
  brand_name: string | null; aired_on: string | null; rank: number;
}
export interface Promise_ {
  id: string; brand_id: string; show_id: string | null; source_id: string; segment_start: number; segment_end: number;
  start_ms: number | null; end_ms: number | null; verbatim_text: string; normalized_text: string | null; speaker_label: string | null;
  person_id: string | null; due_phrase: string | null; suggested_due_on: string | null; due_on: string | null;
  status: 'candidate' | 'confirmed' | 'nudge_sent' | 'fulfilled' | 'broken' | 'dismissed'; assignee: string | null;
  follow_up_show_id: string | null; resolution_note: string | null; dismissed_reason: string | null; is_overdue?: boolean;
  created_at: string;
}
export interface RecallFlag {
  id: string; source_id: string; kind: 'contradiction_candidate' | 'prior_statement' | 'recurring_topic' | 'open_promise';
  summary: string; person_id: string | null; topic: string | null; topic_count: number | null;
  citations: { source_id: string; idx: number }[]; status: 'open' | 'confirmed_for_review' | 'dismissed'; created_at: string;
}
export interface Finding {
  id: string; query_id: string; url: string; publisher: string; title: string; published_on: string | null; retrieved_at: string;
  excerpt: string; label: string; status: 'retrieved' | 'confirmed_for_use' | 'rejected'; used_on_brief_id: string | null;
}
export interface ResearchQuery { id: string; query_text: string; status: 'queued' | 'done' | 'failed'; error: string | null; provider: string | null; created_at: string; brief_id: string | null }
export interface Contribution { id: string; object_id: string; user_id: string | null; person_id: string | null; role: string; note: string | null; locked_at: string | null }
export interface Metric {
  id: string; episode_id: string; person_id: string | null; metric_type: 'airtime_ms' | 'reach' | 'engagement' | 'revenue';
  value: number; unit: string; currency: string | null; platform: string | null; definition: string | null; evidence_type: string;
  evidence_url: string | null; evidence_note: string | null; status: 'draft' | 'pending_approval' | 'approved' | 'rejected';
  rejection_reason: string | null; created_at: string;
}
export interface ApprovedMetric {
  metric_id: string; episode_id: string; metric_type: string; platform: string | null; unit: string; currency: string | null;
  person_id: string; attributed_value: number; total_value: number; attribution_rule: string; evidence_url: string | null; approved_at: string;
}
export interface Notification { id: string; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }
export interface PostShowReport {
  id: string; source_id: string; status: 'draft' | 'accepted'; created_at: string;
  body: {
    summary: string; topics: { theme: string; segment_start: number }[];
    speakers: { label: string; person_id: string | null; name: string | null; segments: number }[];
    unanswered_questions: { question: string; why: string; segment_start: number; segment_end: number; quote: string }[];
    promise_candidates: { quote: string; due_phrase: string | null; segment_start: number }[];
    recall_flags: Record<string, number>;
    clip_candidates: { why: string; segment_start: number; segment_end: number; quote: string }[];
    next_actions: string[];
  };
}

export const FLAG_LABEL: Record<RecallFlag['kind'], string> = {
  contradiction_candidate: 'Possible tension (review)', prior_statement: 'Said before', recurring_topic: 'Recurring topic', open_promise: 'Open promise',
};
export const PROMISE_LABEL: Record<Promise_['status'], string> = {
  candidate: 'Candidate', confirmed: 'Tracked', nudge_sent: 'Nudged', fulfilled: 'Fulfilled', broken: 'Broken', dismissed: 'Dismissed',
};

export function usePeopleDirectory(orgId: string | undefined) {
  return useQuery({
    queryKey: ['people-dir', orgId], enabled: !!orgId,
    queryFn: async () => check(await supabase.from('people').select('*').eq('org_id', orgId!).order('display_name')) as Person[],
  });
}

/** Short-lived signed URL for a private media object. */
export function useSignedUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['signed', path], enabled: !!path, staleTime: 50 * 60_000,
    queryFn: async () => check(await supabase.storage.from('media').createSignedUrl(path!, 3600))!.signedUrl,
  });
}

export async function signedDownload(path: string, filename: string) {
  const r = check(await supabase.storage.from('media').createSignedUrl(path, 600, { download: filename }));
  window.open(r!.signedUrl, '_blank', 'noopener');
}
