"""Local, pinned Laya 0.3.5 JSONL worker. Research only; no downloads."""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time


def digest_tree(root: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        h.update(str(path.relative_to(root)).encode())
        h.update(b'\0')
        with path.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
    return h.hexdigest()


def main() -> None:
    checkpoint = Path(sys.argv[1]).resolve(strict=True)
    if not checkpoint.is_dir():
        raise ValueError('checkpoint_must_be_local_directory')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    if importlib.metadata.version('laya') != '0.3.5':
        raise ValueError('requires_verified_laya_0_3_5')
    config = json.loads((checkpoint / 'rl_agent_config.json').read_text())
    if 'mmbert' not in str(config.get('encoder', '')).lower():
        raise ValueError('requires_multilingual_mmbert_checkpoint')
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        import laya
        from laya.common import build_sequence
        agent = laya.load(str(checkpoint))
    # Hash after loading, because the SDK can repair tokenizer configuration on disk.
    metadata = {'ready': True, 'model': 'laya-multilingual',
                'sdk': importlib.metadata.version('laya'),
                'checkpoint_sha256': digest_tree(checkpoint),
                'encoder': config['encoder'], 'device': str(agent.device),
                'startup_ms_including_hash': (time.perf_counter() - started) * 1000,
                'context_check': 'compare configured sequence with untruncated sequence',
                'probability_rounding_decimals': 4}
    print(json.dumps(metadata), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 64 * 1024:
                raise ValueError('request_too_large')
            request = json.loads(line)
            # Refuse truncation instead of silently discarding symptoms/negation.
            for qdef in request['questions'].values():
                q = agent._to_internal(qdef)
                normal = build_sequence(agent.tok, request['state'], q,
                                        agent.cfg.get('max_len', 512),
                                        agent.cfg.get('head_max_len', 192))
                full = build_sequence(agent.tok, request['state'], q, 100000, 100000)
                if normal != full:
                    raise ValueError('context_truncation_refused')
            with contextlib.redirect_stdout(sys.stderr):
                result = agent.predict(request['state'], request['questions'])
            print(json.dumps({'id': request['id'], 'result': result,
                              'device': str(agent.device)}, ensure_ascii=False, allow_nan=False), flush=True)
        except Exception as exc:
            # Do not leak request content, filesystem paths or credentials in diagnostics.
            print(json.dumps({'id': request.get('id'), 'error': type(exc).__name__}), flush=True)


if __name__ == '__main__':
    main()
