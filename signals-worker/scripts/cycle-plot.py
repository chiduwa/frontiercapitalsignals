"""Descriptive BTC cycle chart; no projected path or implied trading rule."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def render(root, out):
    parts = []
    for path in sorted((root/'cycles/raw').glob('bitstamp-BTC-*.json')):
        rows = pd.DataFrame(json.loads(path.read_text())['data']['ohlc'])
        if not rows.empty:
            parts.append(pd.Series(pd.to_numeric(rows.close).to_numpy(),
              index=pd.to_datetime(pd.to_numeric(rows.timestamp), unit='s')))
    price = pd.concat(parts).sort_index(); price = price[~price.index.duplicated()]
    halvings = pd.DatetimeIndex(['2012-11-28', '2016-07-09', '2020-05-11', '2024-04-20'])
    colors = ['#6366f1', '#0284c7', '#d97706', '#c026d3']
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False,
                         'axes.spines.right': False, 'axes.titleweight': 'bold'})
    fig, axes = plt.subplots(2, 1, figsize=(12, 9), gridspec_kw={'height_ratios': [1, 1.2]})
    fig.set_facecolor('#fafafa')
    ax = axes[0]; ax.plot(price.index, price, color='#0f172a', linewidth=1)
    ax.set_yscale('log'); ax.set_ylabel('BTC/USD close · log scale')
    ax.set_title('Long history contains several different market conditions', loc='left', pad=16)
    for date, color in zip(halvings, colors):
        ax.axvline(date, color=color, alpha=.6, linewidth=1)
        ax.text(date, ax.get_ylim()[1], str(date.year), color=color, va='top', ha='left')
    ax.grid(alpha=.16)
    ax = axes[1]
    for i, (begin, color) in enumerate(zip(halvings, colors)):
        finish = halvings[i+1] if i+1 < len(halvings) else price.index.max()+pd.Timedelta(days=1)
        p = price[(price.index >= begin) & (price.index < finish)]
        if p.empty: continue
        label = f'{begin.year}–{finish.year}' if i<3 else f'2024–{price.index.max().year} · incomplete'
        ax.plot((p.index-begin).days, p/p.iloc[0], color=color, linewidth=1.3, label=label)
    ax.axhline(1, color='#64748b', linewidth=.7)
    ax.set_yscale('log'); ax.set_xlabel('Observed days since that halving')
    ax.set_ylabel('Price / close on halving day · log scale')
    ax.set_title('The path, timing and size of moves differ between cycles', loc='left', pad=16)
    ax.grid(alpha=.16); ax.legend(frameon=False, ncol=2, loc='upper left')
    fig.suptitle('A halving schedule is not a price forecast', x=.08, ha='left', fontsize=21, fontweight='bold')
    fig.text(.08, .035, f'Source: Bitstamp daily BTC/USD, {price.index.min().date()}–{price.index.max().date()}; Bitcoin.org halving dates.\n'
             'Descriptive history only. Three completed inter-halving intervals; no future path is drawn.', color='#475569', fontsize=9)
    fig.subplots_adjust(left=.08, right=.97, bottom=.12, top=.88, hspace=.4)
    out.mkdir(parents=True, exist_ok=True)
    fig.savefig(out/'bitcoin-cycles.png', dpi=160, facecolor=fig.get_facecolor())
    fig.savefig(out/'bitcoin-cycles.svg', facecolor=fig.get_facecolor())
    svg = out/'bitcoin-cycles.svg'
    svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines()) + '\n')
    plt.close(fig)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='reports/scenarios')
    ap.add_argument('--out', default='docs/research-2026-10-08-cycles')
    a = ap.parse_args(); render(Path(a.data), Path(a.out))
