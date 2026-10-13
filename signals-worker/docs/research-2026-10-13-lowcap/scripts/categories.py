"""Primary narrative category + backer flags per pair, from CMC tags (live: snapshot; delisted:
fetched here). Tags are today's labels, so they are a mild look-ahead for narratives that were
coined later (e.g. 'ai-agents'); the report flags this. Output: raw/cmc_tags.json (sym->category),
raw/cmc_flags.json (sym->{flag:bool})."""
import concurrent.futures as cf
from common import get, load, dump

ORDER = [
    ('fan_token', {'fan-token', 'sports', 'soccer'}),
    ('meme', {'memes', 'animal-memes', 'doggone-doggerel'}),
    ('ai', {'ai-big-data', 'generative-ai', 'ai-agents'}),
    ('gaming', {'gaming', 'play-to-earn', 'metaverse'}),
    ('privacy', {'privacy', 'privacy-coins', 'privacy-blockchain', 'zero-knowledge-proofs'}),
    ('rwa', {'real-world-assets-protocols', 'tokenized-stock', 'rwa'}),
    ('depin', {'depin', 'storage', 'distributed-computing', 'iot', 'filesharing'}),
    ('defi', {'defi', 'decentralized-exchange-dex-token', 'dex', 'lending-borowing', 'derivatives', 'perpetuals',
              'yield-farming', 'amm', 'liquid-staking-derivatives', 'restaking'}),
    ('l1_l2', {'layer-1', 'layer-2', 'smart-contracts', 'platform', 'modular-blockchain', 'scaling', 'rollups'}),
    ('nft', {'collectibles-nfts', 'marketplace'}),
    ('payments', {'payments', 'medium-of-exchange'}),
    ('infra', {'oracles', 'interoperability', 'web3', 'cross-chain', 'enterprise-solutions', 'wallet'}),
]
TOP_VC = {'a16z-portfolio', 'paradigm-portfolio', 'polychain-capital-portfolio', 'multicoin-capital-portfolio',
          'pantera-capital-portfolio', 'coinbase-ventures-portfolio', 'dragonfly-capital-portfolio',
          'electric-capital-portfolio', 'framework-ventures-portfolio', 'placeholder-ventures-portfolio',
          'blockchain-capital-portfolio', 'galaxy-digital-portfolio', 'sequoia-capital-portfolio'}

choice = load('cmc_choice.json')
snap = {int(k): v for k, v in load('snap_cmc.json').items() if v}
need = sorted({c for c in choice.values() if c and c not in snap})


def detail(cid):
    j = get(f'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id={cid}', pause=0.3)
    d = (j or {}).get('data')
    return cid, ({'tags': d.get('tags'), 'name': d.get('name')} if d else None)


with cf.ThreadPoolExecutor(3) as ex:
    for cid, d in ex.map(detail, need):
        if d:
            snap[cid] = d
cat, flags = {}, {}
for sym, cid in choice.items():
    d = snap.get(cid)
    tags = {t['slug'] if isinstance(t, dict) else t for t in ((d or {}).get('tags') or [])}
    cat[sym] = next((name for name, s in ORDER if tags & s), 'other')
    flags[sym] = {'dwf': 'dwf-labs-portfolio' in tags, 'binance_labs': 'binance-labs-portfolio' in tags,
                  'top_vc': bool(tags & TOP_VC), 'wlfi': 'world-liberty-financial-portfolio' in tags,
                  'launchpool': bool(tags & {'binance-launchpool', 'binance-launchpad', 'binance-hodler-airdrops', 'binance-megadrop'}),
                  'made_in_america': 'made-in-america' in tags, 'n_tags': len(tags)}
dump(cat, 'cmc_tags.json')
dump(flags, 'cmc_flags.json')
import collections
print(collections.Counter(cat.values()))
