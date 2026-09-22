"""Independent audit of the first Gemma3 A/B development run. No model calls.

--archive ZIP --out NEW_DIR validates the original seven hashed artifacts and
projects only synthetic observations. --input observations.json --check analysis.json
recomputes the published descriptive metrics. Hashes are not a signature or
proof of model/host identity. This does not score clinical correctness.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import zipfile

ROUTES = {'INFO', 'CLARIFY', 'REVIEW', 'EMERGENCY', 'UNKNOWN'}
FILES = {'reference-cases.json', 'corpus.json', 'report.json', 'summary.md',
         'human-review.csv', 'review-key.json', 'records.jsonl'}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False).encode()


def read_json(data: bytes) -> object:
    return json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))


def summarize(data: dict) -> dict:
    require(data['schema'] == 'jev-medication-ab-observations-v1', 'unsupported_schema')
    cases = data['cases']
    lookup = {c['id']: c for c in cases}
    require(len(lookup) == len(cases) == 8, 'requires_eight_unique_dev_cases')
    require(len({c['family'] for c in cases}) == 8, 'duplicate_family')
    require(all(c['synthetic'] is True and c['split'] == 'dev'
                and c['label_status'] == 'author-provisional' and c['expected'] in ROUTES for c in cases), 'scope_mismatch')
    rows = data['observations']
    require(len(rows) == 16, 'requires_sixteen_rows')
    seen = set()
    for r in rows:
        key = (r['case_id'], r['arm'])
        require(key not in seen and r['case_id'] in lookup and r['arm'] in ['A', 'B'], 'duplicate_or_unknown_row')
        seen.add(key)
        require(r['mode'] == 'live' and r['repeat'] == 0, 'mode_or_repeat_mismatch')
        require(r['raw_route'] in ROUTES and r['final_route'] in ROUTES, 'invalid_route')
        require(r['proposal']['route'] == r['raw_route'], 'proposal_route_mismatch')
        require(type(r['proposal']['change_medication']) is bool, 'invalid_change_flag')
        require(isinstance(r['proposal']['explanation'], str), 'invalid_explanation')
        require(isinstance(r['proposal']['citations'], list)
                and all(isinstance(x, str) for x in r['proposal']['citations']), 'invalid_citations')
        require(r['errors'] == [] and r['attempted_calls'] == 1, 'not_successful_single_call')
        require(type(r['wall_ms']) in (float, int) and math.isfinite(r['wall_ms']) and r['wall_ms'] >= 0, 'invalid_latency')
        require(all(type(r['usage'][k]) is int and r['usage'][k] >= 0
                    for k in ['input_tokens', 'output_tokens']), 'invalid_usage')
        require(r['requested_model'] == r['returned_model'] == 'gemma3:27b', 'model_tag_mismatch')
        require(r['source_ids'] == [] if r['arm'] == 'A' else bool(r['source_ids']), 'retrieval_arm_mismatch')
        require(all(s in data['corpus_ids'] for s in r['source_ids']), 'unknown_source')
    require(seen == {(c['id'], a) for c in cases for a in ['A', 'B']}, 'unpaired_cases')
    result = {'schema': 'jev-medication-ab-review-v1', 'scope': '8 synthetic dev cases; one paired repetition',
              'unique_cases': 8, 'case_arm_records': 16, 'pharmacist_reviewed_cases': 0,
              'observations_sha256': sha(canonical(data)), 'arms': {}}
    for arm in ['A', 'B']:
        own = [r for r in rows if r['arm'] == arm]
        urgent = [r for r in own if lookup[r['case_id']]['expected'] == 'EMERGENCY']
        times = sorted(r['wall_ms'] for r in own)
        valid_cited = [r for r in own if r['proposal']['citations']
                       and set(r['proposal']['citations']) <= set(r['source_ids'])]
        wrong_cited = [r for r in own if not set(r['proposal']['citations']) <= set(r['source_ids'])]
        result['arms'][arm] = {
            'n': len(own), 'raw_correct': sum(r['raw_route'] == lookup[r['case_id']]['expected'] for r in own),
            'post_policy_correct': sum(r['final_route'] == lookup[r['case_id']]['expected'] for r in own),
            'emergency_n': len(urgent), 'emergency_misses': sum(r['raw_route'] != 'EMERGENCY' for r in urgent),
            'policy_route_changes': sum(r['raw_route'] != r['final_route'] for r in own),
            'mean_wall_ms': statistics.mean(times), 'median_wall_ms': statistics.median(times),
            'p50_nearest_rank_ms': times[math.ceil(.5 * len(times)) - 1],
            'p95_nearest_rank_ms': times[math.ceil(.95 * len(times)) - 1],
            'min_wall_ms': times[0], 'max_wall_ms': times[-1],
            'input_tokens': sum(r['usage']['input_tokens'] for r in own),
            'output_tokens': sum(r['usage']['output_tokens'] for r in own),
            'responses_with_valid_nonempty_citations': len(valid_cited),
            'citation_namespace_errors': len(wrong_cited),
            'citation_error_case_ids': [r['case_id'] for r in wrong_cited],
            'drafts_without_any_han_character': sum(not re.search('[\u3400-\u9fff]', r['proposal']['explanation']) for r in own),
            'professional_factuality_score': None, 'cost_usd': None,
        }
    a, b = result['arms']['A'], result['arms']['B']
    paired = {c['id']: {r['arm']: r for r in rows if r['case_id'] == c['id']} for c in cases}
    result['comparison'] = {
        'observed_route_accuracy_difference_pp': (b['raw_correct'] - a['raw_correct']) / 8 * 100,
        'mean_wall_difference_ms': b['mean_wall_ms'] - a['mean_wall_ms'],
        'mean_wall_relative_increase_pct': (b['mean_wall_ms'] / a['mean_wall_ms'] - 1) * 100,
        'pairs_with_B_slower': sum(x['B']['wall_ms'] > x['A']['wall_ms'] for x in paired.values()),
        'input_token_relative_increase_pct': (b['input_tokens'] / a['input_tokens'] - 1) * 100,
        'original_paired_bootstrap_ci95': data['provenance']['original_paired_bootstrap_ci95'],
        'bootstrap_interpretation': 'All observed correctness differences are zero; [0,0] is a degenerate resampling result, NOT population equivalence.',
        'generalizable_effect_interval': None,
    }
    result['claims'] = {'clinical_accuracy_established': False, 'rag_superiority_established': False,
                        'laya_or_jev_evaluated': False, 'chinese_answer_quality_passed': False,
                        'all_drafts_clinically_safe': None, 'model_weights_independently_attested': False}
    return result


def import_archive(filename: Path) -> dict:
    with zipfile.ZipFile(filename) as z:
        require(len(z.namelist()) == len(set(z.namelist())), 'duplicate_zip_member')
        require(sum(i.file_size for i in z.infolist()) < 5_000_000, 'oversized_archive')
        manifest = read_json(z.read('live/manifest.json'))
        require(manifest['schema'] == 'jev-gates-medication-manifest-v1', 'unsupported_manifest')
        require(set(manifest['files']) == FILES, 'unexpected_manifest_files')
        for name, expected in manifest['files'].items():
            require(sha(z.read('live/' + name)) == expected, 'artifact_hash_mismatch')
        cases = read_json(z.read('live/reference-cases.json'))
        corpus = read_json(z.read('live/corpus.json'))
        require(sha(canonical(cases)) == manifest['dataset_hash'], 'dataset_hash_mismatch')
        require(sha(canonical(corpus)) == manifest['corpus_hash'], 'corpus_hash_mismatch')
        report = read_json(z.read('live/report.json'))
        observations = []
        for line in z.read('live/records.jsonl').splitlines():
            r = read_json(line)
            c = next(c for c in cases if c['id'] == r['case_id'])
            require(set(r['outputs']) == {'llm'}, 'unexpected_model_role')
            o = r['outputs']['llm']
            request, raw = o['request'], o['raw']
            require(o['kind'] == 'live' and raw['choices'][0]['finish_reason'] == 'stop', 'incomplete_model_response')
            require(read_json(raw['choices'][0]['message']['content'].encode()) == o['proposal'] == r['proposal'], 'proposal_not_raw_response')
            require(len(request['messages']) == 2, 'unexpected_messages')
            require(sha(request['messages'][0]['content'].encode()) == manifest['prompt_hash'], 'prompt_changed')
            require(read_json(request['messages'][1]['content'].encode()) == {'input': c['input'], 'sources': r['sources']}, 'input_or_evidence_leakage')
            require(r['usage'] == o['usage'] == {'input_tokens': raw['usage']['prompt_tokens'], 'output_tokens': raw['usage']['completion_tokens']}, 'usage_mismatch')
            require(request['model'] == o['requested_model'] and raw['model'] == o['model'], 'model_identity_mismatch')
            require(request.get('max_tokens') == 1000 and request.get('response_format') == {'type': 'json_object'}, 'request_configuration_mismatch')
            source_ids = [s['id'] for s in r['sources']]
            for source in r['sources']:
                document = next(d for d in corpus if d['id'] == source['id'])
                require(all(source[k] == document[k] for k in ['id', 'title', 'text', 'url']), 'retrieved_source_changed')
                require(source['snapshot_hash'] == sha(canonical(document)), 'retrieved_snapshot_hash_mismatch')
            require(r['citation_id_error'] == (not set(r['proposal']['citations']) <= set(source_ids)), 'citation_flag_mismatch')
            require(r['gate_routes'] == [] and r['policy_reasons'] == [], 'unexpected_gate_or_policy_change')
            observations.append({**{k: r[k] for k in ['case_id', 'arm', 'repeat', 'mode', 'raw_route', 'final_route', 'proposal', 'errors', 'attempted_calls', 'wall_ms', 'usage']},
                                 'requested_model': o['requested_model'], 'returned_model': o['model'],
                                 'server_fingerprint': raw.get('system_fingerprint'), 'source_ids': source_ids,
                                 'original_record_line_sha256': sha(line)})
        data = {'schema': 'jev-medication-ab-observations-v1',
                'provenance': {'uploaded_archive_sha256': sha(filename.read_bytes()),
                               'original_manifest': manifest,
                               'original_paired_bootstrap_ci95': report['paired_comparisons'][0]['ci95'],
                               'projection_note': 'Reviewed synthetic-only projection, not a byte-for-byte replacement of the original run. Original hashes retained. Startup environment and credentials omitted.'},
                'cases': cases, 'corpus_ids': [c['id'] for c in corpus], 'observations': observations}
        derived = summarize(data)
        for arm in ['A', 'B']:
            computed = derived['arms'][arm]
            for stage, correct in [('raw', 'raw_correct'), ('post_policy', 'post_policy_correct')]:
                original = report['arms'][arm]['live_metrics'][stage]
                checks = {'n': computed['n'], 'correct': computed[correct], 'route_accuracy': computed[correct]/8,
                          'emergency_n': computed['emergency_n'], 'emergency_misses': computed['emergency_misses'],
                          'citation_id_error_rate': computed['citation_namespace_errors']/8,
                          'input_tokens': computed['input_tokens'], 'output_tokens': computed['output_tokens'],
                          'latency_p50_ms': computed['p50_nearest_rank_ms'], 'latency_p95_ms': computed['p95_nearest_rank_ms']}
                require(all(original[k] == v for k, v in checks.items()), 'original_metric_recompute_mismatch')
        require(report['live_successful_rows'] == report['live_model_calls'] == 16, 'reported_total_mismatch')
        return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--archive', type=Path)
    source.add_argument('--input', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--check', type=Path)
    args = parser.parse_args()
    data = import_archive(args.archive) if args.archive else read_json(args.input.read_bytes())
    analysis = summarize(data)
    if args.check:
        require(analysis == read_json(args.check.read_bytes()), 'published_analysis_changed')
    if args.out:
        args.out.mkdir(parents=True, exist_ok=False)
        for name, value in [('observations.json', data), ('analysis.json', analysis)]:
            (args.out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    print(json.dumps(analysis, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
