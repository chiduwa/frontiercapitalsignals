#!/usr/bin/env python3
"""The wide sequence screen, step 2 of 3: score every batch that
sequence-wide-batches.mjs wrote, in parallel, one core per batch
(docs/SEQUENCE_MODELS.md, "The wide screen"). Research only.

    python scripts/sequence-wide-run.py <outDir> [--workers 5] [--test-days 360]

Each batch's rows are built with --sequence (crypto leaders fixed to the
always-tracked coins, so no asset's inputs depend on its batch), scored by
tracked-sequence-research.py into <outDir>/out/<id>/report.json, and deleted.
A finished batch is skipped on a re-run, so an interrupted screen resumes.
Step 3 corrects ALL reports together (tracked-sequence-combine.py): a batch
corrected on its own is an uncorrected search.
"""
import argparse, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRACKED = 'BTC,ETH,SOL,XLM,XRP,HYPE,HBAR,ARB'


def work(b, out_dir, test_days):
    out = out_dir / 'out' / b['id']
    if (out / 'report.json').exists(): return b['id'], 'done earlier', 0
    t0 = time.time(); rows = out_dir / f"rows-{b['id']}.json"
    env = dict(os.environ, OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
    cmd = ['node', str(HERE / 'tracked-research-data.mjs'), str(out_dir / 'panels' / f"{b['id']}.json"), str(rows),
           '--sequence', '--symbols', ','.join(b['symbols']), '--asset-class', b['assetClass']]
    if b['assetClass'] == 'crypto': cmd += ['--leaders', TRACKED]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode: return b['id'], 'rows failed: ' + r.stderr[-300:], time.time() - t0
    r = subprocess.run([sys.executable, str(HERE / 'tracked-sequence-research.py'), '--input', str(rows), '--output', str(out),
                        '--test-days', str(test_days)], capture_output=True, text=True, env=env)
    rows.unlink(missing_ok=True)
    return b['id'], ('ok' if r.returncode == 0 else 'model failed: ' + r.stderr[-300:]), time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir'); ap.add_argument('--workers', type=int, default=5); ap.add_argument('--test-days', type=int, default=360)
    a = ap.parse_args()
    out_dir = Path(a.out_dir).resolve()
    batches = json.loads((out_dir / 'batches.json').read_text())
    (out_dir / 'out').mkdir(exist_ok=True)
    failed = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for bid, status, secs in ex.map(lambda b: work(b, out_dir, a.test_days), batches):
            failed += not status.startswith(('ok', 'done'))
            print(f"{time.strftime('%H:%M:%S')} {bid} {status} {secs:.0f}s", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
