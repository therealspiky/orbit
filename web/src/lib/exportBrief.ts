import { clock } from './format';
import { STATUS_LABEL, type Brief, type BriefVersion, type Evidence, type ReviewDecision, type Task } from './types';

const V: Record<string, string> = {
  verified: 'verified by a person', auto_matched: 'quote matches transcript (not yet listened to)', unverified: 'unverified', failed: 'NOT SUPPORTED',
};

/** Markdown export that carries evidence, uncertainty and review state, not only the polished copy. */
export function briefToMarkdown(args: {
  brief: Brief; version: BriefVersion; evidence: Evidence[]; decisions: ReviewDecision[]; tasks: Task[];
  showName: string; brandName: string; sourceTitle: string | null; person: (id: string | null) => string;
}): string {
  const { brief, version: v, evidence, decisions, tasks } = args;
  const c = v.content;
  const L: string[] = [];
  const h = (s: string) => L.push('', `## ${s}`, '');
  L.push(`# ${c.title}`, '');
  L.push(`${args.showName} (${args.brandName}). Status: ${STATUS_LABEL[brief.status]}. Version ${v.version}, ${new Date(v.created_at).toLocaleString()}.`);
  if (args.sourceTitle) L.push(`Source: ${args.sourceTitle}.`);
  L.push(`Recommendation: ${c.recommendation === 'proceed' ? 'proceed' : 'research first'} — ${c.recommendation_reason}`);
  if (v.generated) L.push(`Drafted by ${v.model} (prompt ${v.prompt_version}); human edits are recorded as later versions.`);

  h('Premise'); L.push(c.premise);
  h('Why now'); L.push(c.why_now);
  h('Audience value'); L.push(c.audience_value);
  h('New contribution'); L.push(c.new_contribution);
  h('Fit with the show profile'); L.push(c.destination_fit.summary, ...c.destination_fit.profile_fields.map((f) => `- ${f.field}: ${f.how_it_fits}`));

  h('Evidence');
  for (const e of evidence) {
    const where = e.start_ms != null ? `${clock(e.start_ms)}–${clock(e.end_ms)}` : `passage ${e.segment_start}–${e.segment_end}`;
    L.push(`- **${e.ref_key}** (${where}${e.attribution ? `, ${e.attribution}` : ''}; ${V[e.verification]})${e.quote ? `: "${e.quote}"` : ''}`);
    const rel = c.evidence.find((x) => x.ref === e.ref_key)?.relevance;
    if (rel) L.push(`  ${rel}`);
  }
  if (!evidence.length) L.push('No source evidence. Treat this brief as a research plan.');
  if (c.uncertainties.length) { h('Uncertainties'); L.push(...c.uncertainties.map((u) => `- ${u}`)); }

  h('Treatment');
  L.push(`${c.treatment.format}, ${c.treatment.duration_minutes} minutes.`, '', `**Opening:** ${c.treatment.presenter_opening}`, '');
  L.push('**Lines of inquiry**', ...c.treatment.lines_of_inquiry.map((l) => `- ${l.question}${l.evidence_refs.length ? ` [${l.evidence_refs.join(', ')}]` : ''}`));
  L.push('', '**Interview questions**', ...c.treatment.interview_questions.map((q) => `- ${q}`), '', `**Takeaway:** ${c.treatment.takeaway}`);

  h('Rundown');
  L.push('| Start | Min | Segment | Purpose | Owner | Evidence |', '|---|---|---|---|---|---|');
  for (const r of c.rundown) {
    L.push(`| ${r.start_minute} | ${r.duration_minutes} | ${r.is_break ? 'BREAK' : r.title} | ${r.purpose} | ${r.owner_role} | ${r.evidence_refs.join(', ')} |`);
  }
  L.push('', `Total: ${c.rundown.reduce((n, r) => n + r.duration_minutes, 0)} minutes.`);

  h('Guests (perspectives, not booked people)');
  for (const g of c.guests) L.push(`- **${g.perspective_needed}** — ${g.suggested_profile}. ${g.why_needed}${g.credentials_to_verify.length ? ` Verify: ${g.credentials_to_verify.join('; ')}.` : ''}`);

  h('Social package (planned, not rendered)');
  for (const a of c.social_package) L.push(`- **${a.asset_type}** for ${a.platform} (${a.format}): ${a.hook}`, `  Caption draft: ${a.caption_draft}`);

  h('Tasks');
  for (const t of tasks) L.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.blocking ? ' (blocking)' : ''} — ${t.owner_role ?? 'unassigned'}`);

  h('Review state');
  const live = decisions.filter((d) => !d.invalidated_at && d.brief_version_id === v.id);
  if (!live.length) L.push('No review decisions on this version.');
  for (const d of live) {
    L.push(`- ${d.is_final_approval ? 'Final approval' : `${d.check_key}: ${d.outcome}`} by ${args.person(d.reviewer)} (${d.reviewer_role}), ${new Date(d.created_at).toLocaleString()}${d.reason ? ` — ${d.reason}` : ''}`);
  }
  for (const f of c.review_flags) L.push(`- Flag (${f.check}, ${f.severity}): ${f.concern}`);

  h('After the programme');
  L.push(...c.continuation.post_show_questions.map((q) => `- ${q}`));
  if (c.continuation.follow_up_ideas.length) L.push('', ...c.continuation.follow_up_ideas.map((f) => `- Follow-up: ${f.title} — ${f.advance}`));
  L.push('', '---', `Exported from Orb.IT ${new Date().toLocaleString()}. Approval applies to version ${v.version} only.`);
  return L.join('\n');
}

export function download(filename: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Approved export package (export_brief_package): copy sheet with credits, clip manifest and labelled external sources. */
export interface ExportPackage {
  brief_id: string; version_id: string; exported_at: string;
  credits: { role: string; person: string }[];
  clips: { id: string; headline: string; aspect_ratio: string; video_path: string | null; srt_path: string | null; vtt_path: string | null;
    caption_text: string | null; caption_differs: boolean; music_flag: boolean; start_ms: number; end_ms: number }[];
  external_sources: { url: string; publisher: string; title: string; published_on: string | null; label: string }[];
}

export function packageToMarkdown(briefMd: string, pkg: ExportPackage): string {
  const L: string[] = [briefMd.trimEnd(), '', '---', '', `# Export package (${new Date(pkg.exported_at).toLocaleString()})`, ''];
  L.push('## Credits', '');
  if (pkg.credits.length) L.push(...pkg.credits.map((c) => `- ${c.person}: ${c.role.replace(/_/g, ' ')}`));
  else L.push('No credits recorded.');
  L.push('', '## Clips', '');
  if (!pkg.clips.length) L.push('No rendered clips.');
  for (const c of pkg.clips) {
    L.push(`- **${c.headline}** (${c.aspect_ratio}, ${clock(c.start_ms)}–${clock(c.end_ms)})`);
    L.push(`  Files: ${[c.video_path, c.srt_path, c.vtt_path].filter(Boolean).join(', ')}`);
    if (c.caption_differs) L.push('  Captions were edited and differ from the transcript wording.');
    if (c.music_flag) L.push('  Contains music or long non-speech: check rights before publishing.');
  }
  L.push('', '## External sources (not Orb.IT archive quotes)', '');
  if (!pkg.external_sources.length) L.push('None confirmed for use.');
  for (const s of pkg.external_sources) {
    L.push(`- [EXTERNAL] ${s.title}. ${s.publisher}, ${s.published_on ?? 'date unknown'}. ${s.url}`);
  }
  return L.join('\n') + '\n';
}
