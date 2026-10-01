"""Utility taxonomy: what a token is USED FOR, keyed to CoinGecko category ids.

Ecosystem ("deployed on X") and investor-portfolio categories are deliberately
absent: they say where a token lives or who bought it, not what it does.
ECOSYSTEMS is kept separately, for research only.
"""
UTILITY = {
    "gas":          ("Pays network fees", ["smart-contract-platform", "layer-1", "layer-0-l0", "sidechain", "gaming-blockchains", "appchains", "modular-blockchain", "privacy-blockchain", "directed-acyclic-graph-dag"]),
    "scaling":      ("Scaling (L2 / rollups / ZK)", ["layer-2", "rollup", "zero-knowledge-zk", "rollups-as-a-service-raas", "bitcoin-layer-2", "parallel-evm", "data-availability"]),
    "staking":      ("Staked to secure a network", ["proof-of-stake-pos", "masternodes"]),
    "mining":       ("Mined (proof of work)", ["proof-of-work-pow", "bitcoin-fork"]),
    "payments":     ("Payments and transfers", ["payment-solutions", "crypto-card-issuer", "neobank"]),
    "stablecoin":   ("Stablecoin", ["stablecoins", "usd-stablecoin", "fiat-backed-stablecoin", "crypto-backed-stablecoin", "algorithmic-stablecoin", "synthetic-dollar", "yield-bearing-stablecoins", "eur-stablecoin"]),
    "exchange":     ("Exchange token (fee discounts, launches)", ["exchange-based-tokens", "centralized-exchange-token-cex", "cefi"]),
    "dex":          ("Decentralized trading (DEX)", ["decentralized-exchange", "automated-market-maker-amm", "dex-aggregator", "mev-protection", "intent"]),
    "lending":      ("Lending and borrowing", ["lending-borrowing", "fixed-interest"]),
    "derivatives":  ("Perps, options, synthetics", ["decentralized-perpetuals", "decentralized-derivatives", "decentralized-options", "synthetic", "synths", "synthetic-issuer"]),
    "prediction":   ("Prediction markets and betting", ["prediction-markets", "gambling"]),
    "liquid-staking": ("Liquid staking / restaking", ["liquid-staking", "restaking", "liquid-staking-governance-tokens", "liquid-restaking-governance-token", "lsdfi", "lrtfi"]),
    "yield":        ("Yield strategies", ["yield-farming", "yield-aggregator", "yield-optimizer", "yield-tokenization", "yield-bearing-tokens", "btcfi"]),
    "oracle":       ("Oracle / data feeds", ["oracle", "analytics", "infofi"]),
    "interop":      ("Bridges and cross-chain", ["cross-chain-communication", "chain-abstraction", "bridge-governance-tokens"]),
    "privacy":      ("Privacy", ["privacy", "privacy-coins", "privacy-infrastructure", "vpn"]),
    "ai":           ("AI (agents, models, compute markets)", ["artificial-intelligence", "ai-agents", "ai-applications", "defai", "bittensor-subnets"]),
    "depin":        ("Physical infrastructure (storage, compute, wireless, energy)", ["depin", "storage", "internet-of-things-iot", "robotics", "energy", "mobile-mining"]),
    "rwa":          ("Real-world assets / tokenization", ["real-world-assets-rwa", "rwa-protocol", "tokenized-products", "tokenized-private-credit", "tokenized-treasuries", "tokenized-commodities", "tokenized-credit", "tokenized-stock", "stablecoin-issuer"]),
    "gaming":       ("Gaming and metaverse", ["gaming", "play-to-earn", "metaverse", "gaming-utility-token", "gaming-governance-token", "gaming-platform", "on-chain-gaming", "simulation-games", "rpg", "card-games", "gaming-marketplace", "quest-to-earn"]),
    "nft":          ("NFTs and inscriptions", ["non-fungible-tokens-nft", "nft-marketplace", "nftfi", "inscriptions", "brc-20", "runes"]),
    "social":       ("Social, identity, naming", ["socialfi", "identity", "name-service", "communication", "telegram_apps", "entertainment"]),
    "infra":        ("Developer infrastructure", ["infrastructure", "wallets", "account-abstraction", "cybersecurity", "decentralized-science-desci"]),
    "governance":   ("Governance voting", ["governance", "metagovernance"]),
    "meme":         ("Meme (community and speculation; no built-in use)", ["meme-token", "dog-themed-coins", "cat-themed-coins", "frog-themed-coins", "4chan-themed", "elon-musk-inspired-coins", "politifi", "trump-affiliated-tokens", "chinese-meme", "ai-meme-coins", "ip-meme", "parody-meme-coins", "celebrity-themed-coins", "wojak-themed", "bitcoin-meme", "the-boy-s-club", "zoo-themed", "murad-picks"]),
}
ECOSYSTEMS = ["solana-ecosystem", "ethereum-ecosystem", "base-ecosystem", "binance-smart-chain", "arbitrum-ecosystem",
              "avalanche-ecosystem", "sui-ecosystem", "cosmos-ecosystem", "hyperliquid-ecosystem", "bitcoin-ecosystem", "near-protocol-ecosystem", "tron-ecosystem", "ton-ecosystem"]
